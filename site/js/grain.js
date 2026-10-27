// Animated grain-structure background: a Voronoi "microstructure" that coarsens
// on load (grain growth) and heats up around the pointer.
(function () {
  const canvas = document.getElementById("grain");
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!gl) {
    canvas.classList.add("no-gl");
    window.Grain = { setFocusHue() {} };
    return;
  }

  const vert = `
    attribute vec2 p;
    void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

  const frag = `
    precision highp float;
    uniform vec2 res;
    uniform float time;
    uniform float scale;
    uniform vec2 mouse;
    uniform float heat;
    uniform float hue;

    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453);
    }
    float hash1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }

    vec3 hsv(float h, float s, float v) {
      vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      return v * mix(vec3(1.0), k, s);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / res.y;
      vec2 g = uv * scale;
      vec2 cell = floor(g);
      vec2 f = fract(g);

      float d1 = 8.0, d2 = 8.0;
      vec2 id = vec2(0.0);
      vec2 nearest = vec2(0.0);
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 o = vec2(float(i), float(j));
          vec2 h = hash2(cell + o);
          vec2 r = o + 0.5 + 0.42 * sin(time * 0.05 + 6.2831 * h) - f;
          float d = dot(r, r);
          if (d < d1) { d2 = d1; d1 = d; id = cell + o; nearest = r; }
          else if (d < d2) { d2 = d; }
        }
      }
      // Distance to the nearest grain boundary.
      float edge = sqrt(d2) - sqrt(d1);

      // Orientation colour, a ghost of an EBSD map: muted hues, very dark.
      float h = hash1(id);
      vec3 grainCol = hsv(fract(h * 0.9 + hue), 0.5, 0.028 + 0.03 * hash1(id + 3.1));

      vec2 m = mouse / res.y;
      float dm = length(uv - m);
      float warm = heat * exp(-dm * dm * 9.0);

      vec3 ember = vec3(1.0, 0.33, 0.18);
      vec3 col = mix(grainCol, grainCol * 0.6 + ember * 0.16, warm);

      float line = 1.0 - smoothstep(0.0, 0.035 + 0.02 * warm, edge);
      vec3 boundary = mix(vec3(0.33, 0.39, 0.47) * 0.28, ember * 1.15, warm);
      col = mix(col, boundary, line * (0.55 + 0.45 * warm));

      // Corner glow in DTU red, and a cooler one opposite.
      vec2 q = gl_FragCoord.xy / res;
      col += vec3(0.6, 0.0, 0.0) * 0.22 * smoothstep(0.9, 0.0, length(q - vec2(0.0, 0.0)));
      col += vec3(0.25, 0.33, 0.42) * 0.08 * smoothstep(0.8, 0.0, length(q - vec2(1.0, 1.0)));

      // Film grain.
      col += (hash1(gl_FragCoord.xy + time) - 0.5) * 0.025;
      gl_FragColor = vec4(col, 1.0);
    }`;

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = {};
  ["res", "time", "scale", "mouse", "heat", "hue"].forEach((n) => (u[n] = gl.getUniformLocation(prog, n)));

  // Render below device resolution; the field is soft by nature.
  const quality = 0.6;
  function resize() {
    const w = Math.round(window.innerWidth * quality);
    const h = Math.round(window.innerHeight * quality);
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(u.res, w, h);
    if (reduceMotion) drawStatic();
  }
  window.addEventListener("resize", resize);
  resize();

  const mouse = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5, tx: 0, ty: 0 };
  mouse.tx = mouse.x; mouse.ty = mouse.y;
  let heat = 0, heatTarget = 0;
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    mouse.tx = e.clientX;
    mouse.ty = e.clientY;
    heatTarget = 1;
  });
  document.addEventListener("pointerleave", () => (heatTarget = 0));

  let hue = 0, hueTarget = 0;
  const start = performance.now();
  // Grain growth on load: many fine grains coarsen into a few large ones.
  const growFrom = 48, growTo = 8, growMs = 2600;
  let last = 0;

  function frame(now) {
    if (document.hidden) { requestAnimationFrame(frame); return; }
    if (now - last < 1000 / 40) { requestAnimationFrame(frame); return; }
    last = now;
    const t = (now - start) / 1000;
    const k = Math.min(1, (now - start) / growMs);
    const ease = 1 - Math.pow(1 - k, 3);
    const scale = growFrom * Math.pow(growTo / growFrom, ease);

    mouse.x += (mouse.tx - mouse.x) * 0.08;
    mouse.y += (mouse.ty - mouse.y) * 0.08;
    heat += (heatTarget - heat) * 0.04;
    heatTarget *= 0.995;
    hue += (hueTarget - hue) * 0.05;

    gl.uniform1f(u.time, t);
    gl.uniform1f(u.scale, scale);
    gl.uniform2f(u.mouse, mouse.x * quality, (window.innerHeight - mouse.y) * quality);
    gl.uniform1f(u.heat, heat);
    gl.uniform1f(u.hue, hue);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reduceMotion) requestAnimationFrame(frame);
  }

  function drawStatic() {
    gl.uniform1f(u.time, 0);
    gl.uniform1f(u.scale, 8);
    gl.uniform2f(u.mouse, 0, 0);
    gl.uniform1f(u.heat, 0);
    gl.uniform1f(u.hue, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  if (!reduceMotion) requestAnimationFrame(frame);

  window.Grain = {
    // Each project shifts the grain colours slightly, so moving between
    // projects feels like moving across a specimen.
    setFocusHue(index) { hueTarget = index * 0.137; },
  };
})();
