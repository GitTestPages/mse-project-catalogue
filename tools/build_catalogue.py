"""Build the website's project data from the catalogue PowerPoint(s).

Usage:
    python tools/build_catalogue.py                 # reads every *.pptx in catalogue/
    python tools/build_catalogue.py some.pptx ...   # reads the given files

Each slide is one project laid out like the catalogue template: "PROJECT LEVEL:"
and the title at the top, the figure on the left with SUPERVISORS and
COLLABORATION to its right, then the PROJECT BACKGROUND / AIM / ACTIVITIES /
PRACTICAL NOTES sections. Slides are read by position, so moved or extra text
boxes are fine. The figure (pictures plus any labels drawn on them) is rebuilt
as laid out on the slide.

Optional, in a slide's speaker notes:
    Tags: simulation, tungsten, fusion
    Status: taken

Writes site/data/projects.js and copies images to site/images/projects/.
Only the Python standard library is needed. On Windows, TIFF/EMF figures and
very large photos are converted with tools/convert_image.ps1 and cached in
tools/image-cache/ (commit that folder so other machines can build too).
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
IMG_DIR = SITE / "images" / "projects"
TOOLS = ROOT / "tools"
CACHE = TOOLS / "image-cache"

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
A = "{%s}" % NS["a"]
P = "{%s}" % NS["p"]
R_EMBED = "{%s}embed" % NS["r"]
R_ID = "{%s}id" % NS["r"]
EMU = 914400

BOILERPLATE = {
    "MATERIALS AND SURFACE ENGINEERING",
    "DEPARTMENT OF CIVIL AND MECHANICAL ENGINEERING",
    "DTU CONSTRUCT / MATERIALS AND SURFACE ENGINEERING",
}
SECTION_RE = re.compile(
    r"^(?:0?\d\s*/\s*)?(PROJECT BACKGROUND|PROJECT AIMS?|PROJECT ACTIVITIES|PRACTICAL NOTES)\b\s*(.*)$", re.I)
SECTIONS = {
    "PROJECT BACKGROUND": ("background", "Background"),
    "PROJECT AIM": ("aim", "Aim"),
    "PROJECT AIMS": ("aim", "Aim"),
    "PROJECT ACTIVITIES": ("activities", "What you will work on"),
    "PRACTICAL NOTES": ("notes", "Practical notes"),
}
LEVEL_RE = re.compile(r"^PROJECT LEVELS?\s*:?\s*(.*)$", re.I)
SUPERVISORS_RE = re.compile(r"^SUPERVISORS?$", re.I)
COLLAB_RE = re.compile(r"^COLLABORATIONS?$", re.I)
ROLE_RE = re.compile(r"^(lead|main|principal|co)?[\s-]*supervisors?$", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)*")
VALID_EMAIL_RE = re.compile(r"^[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}$")
ORG_RE = re.compile(r"\b(DTU|ApS|A/S|University|Universit\w*|Institute|Laboratory|GmbH|Ltd|Inc|Company)\b", re.I)
WEB_FORMATS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
BIG_FILE = 900 * 1024


# ---------- small helpers ----------

def load_json(name, default):
    path = TOOLS / name
    return json.loads(path.read_text("utf8")) if path.exists() else default


def slugify(text, limit=64):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(slug) > limit:
        slug = slug[:limit + 1].rsplit("-", 1)[0]
    return slug


def normalise(part):
    stack = []
    for seg in part.split("/"):
        if seg == "..":
            if stack:
                stack.pop()
        elif seg and seg != ".":
            stack.append(seg)
    return "/".join(stack)


def rels_for(z, part):
    folder, name = part.rsplit("/", 1)
    rel_path = f"{folder}/_rels/{name}.rels"
    if rel_path not in z.namelist():
        return {}
    out = {}
    for rel in ET.fromstring(z.read(rel_path)):
        target = rel.get("Target")
        if rel.get("TargetMode") == "External":
            continue
        out[rel.get("Id")] = normalise(f"{folder}/{target}" if not target.startswith("/") else target[1:])
    return out


def slide_parts(z):
    pres = ET.fromstring(z.read("ppt/presentation.xml"))
    rels = rels_for(z, "ppt/presentation.xml")
    ids = pres.find("p:sldIdLst", NS)
    return [rels[s.get(R_ID)] for s in ids] if ids is not None else []


def notes_text(z, slide_part):
    for target in rels_for(z, slide_part).values():
        if "notesSlides/" in target and target in z.namelist():
            root = ET.fromstring(z.read(target))
            return "\n".join("".join(t.text or "" for t in p.iter(A + "t")) for p in root.iter(A + "p"))
    return ""


def is_titlecase(s):
    words = [w for w in re.findall(r"[A-Za-z][\w'’-]*", s) if len(w) > 3]
    return bool(words) and sum(w[0].isupper() for w in words) / len(words) >= 0.6


def sentence_case(s):
    return s[:1].upper() + s[1:].lower() if s.isupper() else s


def strip_brackets(t):
    t = t.strip()
    if t.startswith("["):
        t = t[1:]
    if t.endswith("]") and t.count("[") < t.count("]"):
        t = t[:-1]
    return t.strip()


def is_placeholder(t):
    return bool(re.fullmatch(r"\[\s*INSERT[^\]]*\]", t.strip(), re.I))


# ---------- reading shapes with real slide coordinates ----------

class Fix:
    """Applies corrections.json to every paragraph."""

    def __init__(self, data):
        self.replace = data.get("replace", {})
        self.exact = data.get("exact", {})

    def __call__(self, text):
        for wrong, right in self.replace.items():
            text = text.replace(wrong, right)
        return self.exact.get(text.strip(), text)


def xfrm_box(xfrm):
    off, ext = xfrm.find(A + "off"), xfrm.find(A + "ext")
    if off is None or ext is None:
        return None
    return [int(off.get("x")), int(off.get("y")), int(ext.get("cx")), int(ext.get("cy"))]


def to_inches(box, tf):
    x, y, w, h = box
    ox, oy, sx, sy = tf
    return {"x": (ox + x * sx) / EMU, "y": (oy + y * sy) / EMU, "w": w * sx / EMU, "h": h * sy / EMU}


def paragraph(p, fix):
    raw = ""
    size = bold = color = None
    for el in p:
        tag = el.tag
        if tag in (A + "r", A + "fld"):
            raw += "".join(t.text or "" for t in el.iter(A + "t"))
            rpr = el.find(A + "rPr")
            if rpr is not None and size is None:
                size = int(rpr.get("sz")) / 100 if rpr.get("sz") else None
                bold = rpr.get("b") == "1"
                clr = rpr.find(f"{A}solidFill/{A}srgbClr")
                color = clr.get("val") if clr is not None else None
        elif tag == A + "br":
            raw += " "
    ppr = p.find(A + "pPr")
    bullet = ppr is not None and (ppr.find(A + "buChar") is not None or ppr.find(A + "buAutoNum") is not None)
    lvl = int(ppr.get("lvl", 0)) if ppr is not None else 0
    align = ppr.get("algn") if ppr is not None else None
    raw = fix(raw)
    text = re.sub(r"\s+", " ", raw).strip()
    return {"text": text, "indent": bool(re.match(r"^\s{3,}", raw)), "bullet": bullet, "lvl": lvl,
            "size": size, "bold": bold, "color": color, "align": align}


def walk(node, tf, out, rels, fix):
    for el in node:
        tag = el.tag
        if tag == P + "grpSp":
            xfrm = el.find(f"{P}grpSpPr/{A}xfrm")
            off, ext = xfrm.find(A + "off"), xfrm.find(A + "ext")
            choff, chext = xfrm.find(A + "chOff"), xfrm.find(A + "chExt")
            ox, oy, sx, sy = tf
            gx, gy = int(off.get("x")), int(off.get("y"))
            cx, cy = int(choff.get("x")), int(choff.get("y"))
            kx = int(ext.get("cx")) / max(1, int(chext.get("cx")))
            ky = int(ext.get("cy")) / max(1, int(chext.get("cy")))
            # child -> group -> parent: parent = gx + (child - cx) * kx
            walk(el, (ox + (gx - cx * kx) * sx, oy + (gy - cy * ky) * sy, sx * kx, sy * ky), out, rels, fix)
        elif tag == P + "sp":
            if el.find(f".//{P}ph[@type='sldNum']") is not None:
                continue
            xfrm = el.find(f"{P}spPr/{A}xfrm")
            box = xfrm_box(xfrm) if xfrm is not None else None
            body = el.find(P + "txBody")
            if box is None or body is None:
                continue
            paras = [paragraph(p, fix) for p in body.iter(A + "p")]
            paras = [p for p in paras if p["text"]]
            if paras:
                out.append({"kind": "text", "box": to_inches(box, tf), "paras": paras})
        elif tag == P + "pic":
            xfrm = el.find(f"{P}spPr/{A}xfrm")
            blip = el.find(f".//{A}blip")
            if xfrm is None or blip is None or blip.get(R_EMBED) not in rels:
                continue
            crop = el.find(f".//{A}srcRect")
            c = {k: int(crop.get(k, 0)) / 100000 for k in "ltrb"} if crop is not None else None
            cnv = el.find(f".//{P}cNvPr")
            out.append({"kind": "pic", "box": to_inches(xfrm_box(xfrm), tf), "part": rels[blip.get(R_EMBED)],
                        "crop": c if c and any(c.values()) else None,
                        "descr": (cnv.get("descr") or "") if cnv is not None else ""})


# ---------- images ----------

class Images:
    def __init__(self, warnings):
        self.done = {}
        self.warnings = warnings
        CACHE.mkdir(exist_ok=True)

    def publish(self, data, ext, box_w, label):
        digest = hashlib.md5(data).hexdigest()
        if digest in self.done:
            return self.done[digest]
        ext = ext.lower()
        needs_convert = ext not in WEB_FORMATS
        too_big = len(data) > BIG_FILE and ext != ".svg"
        src = None
        if needs_convert or too_big:
            cached = sorted(CACHE.glob(digest + ".*"))
            if not cached and os.name == "nt":
                cached = self.convert(data, ext, digest, box_w, label)
            if cached:
                src = cached[0]
            elif needs_convert:
                self.warnings.append(f"{label}: a {ext} figure can't be shown in browsers; "
                                     "run the build once on Windows to convert it")
                self.done[digest] = None
                return None
        name = f"{digest[:12]}{src.suffix if src else ext}"
        if src:
            shutil.copyfile(src, IMG_DIR / name)
        else:
            (IMG_DIR / name).write_bytes(data)
        self.done[digest] = f"images/projects/{name}"
        return self.done[digest]

    def convert(self, data, ext, digest, box_w, label):
        tmp = CACHE / f"_in_{digest}{ext}"
        tmp.write_bytes(data)
        width = int(min(2000, max(900, box_w * 320)))
        try:
            subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                            str(TOOLS / "convert_image.ps1"), "-In", str(tmp),
                            "-OutBase", str(CACHE / digest), "-MaxWidth", str(width)],
                           check=True, capture_output=True, text=True)
        except (subprocess.CalledProcessError, OSError) as e:
            self.warnings.append(f"{label}: could not convert a {ext} image ({getattr(e, 'stderr', e)!s:.120})")
        finally:
            tmp.unlink(missing_ok=True)
        return sorted(CACHE.glob(digest + ".*"))


# ---------- slide -> project ----------

def build_blocks(paras):
    blocks = []
    for p in paras:
        t = strip_brackets(p["text"])
        if not t or is_placeholder(p["text"]):
            continue
        cont = t[0].islower() or t[0] == "("
        if p["bullet"]:
            blocks.append({"t": "li", "text": t, "lvl": min(p["lvl"], 2), "sub": []})
            continue
        last = blocks[-1] if blocks else None
        if p["indent"] and last and last["t"] == "li":
            if last["sub"] and cont:
                last["sub"][-1] += " " + t
            elif not last["sub"] and cont and not last["text"].endswith(":"):
                last["text"] += " " + t
            else:
                last["sub"].append(t)
            continue
        if cont and last:
            if last["t"] == "li" and last["sub"]:
                last["sub"][-1] += " " + t
            else:
                last["text"] += " " + t
            continue
        blocks.append({"t": "p", "text": t})
    return blocks


ORG_START_RE = re.compile(r"^(Institute|University|Universit|Laboratory|Centre|Center|of|for|and)\b")


def parse_people(entries, collab_text):
    """entries: (paragraph text, shape id) from the right-hand column, top to bottom."""
    people, collaboration = [], []
    mode, role = None, ""
    items = [t for t, _ in entries]
    last_collab_shape = None
    for i, (t, shape) in enumerate(entries):
        clean = strip_brackets(t).rstrip(",;").strip()
        if not clean:
            continue
        if SUPERVISORS_RE.match(clean):
            mode = "sup"
            continue
        if COLLAB_RE.match(clean):
            mode = "col"
            continue
        if ROLE_RE.match(clean):
            kind = (ROLE_RE.match(clean).group(1) or "").lower()
            role = "Co-supervisor" if kind == "co" else ("Lead supervisor" if kind else "")
            mode = "sup"
            continue
        if "@" in clean:
            m = EMAIL_RE.search(clean)
            if m and people and not people[-1]["email"]:
                people[-1]["email"] = m.group(0).rstrip(".")
            continue
        nxt = strip_brackets(items[i + 1]) if i + 1 < len(items) else ""
        if mode == "col" and "@" not in nxt:
            # A name wrapped over two lines in one text box: "Danish Technological" / "Institute (DTI)".
            if (collaboration and shape == last_collab_shape and not collaboration[-1].endswith((")", ".", ","))
                    and (clean[0].islower() or ORG_START_RE.match(clean))):
                collaboration[-1] += " " + clean
            else:
                collaboration.append(clean)
            last_collab_shape = shape
            continue
        last = people[-1] if people else None
        is_org = ORG_RE.search(clean) or (len(clean.split()) == 1 and clean.lower() in collab_text)
        if last and not last["email"] and not last["affiliation"] and is_org:
            last["affiliation"] = clean
            continue
        if mode in ("sup", "col"):
            people.append({"name": clean, "email": "", "role": role, "affiliation": ""})
    return people, collaboration


def parse_level(raw):
    raw = strip_brackets(raw)
    low = raw.lower()
    levels = []
    if re.search(r"bachelor|\bbsc\b|\bbeng\b|b\.sc", low):
        levels.append("Bachelor")
    if re.search(r"master|\bmsc\b|m\.sc", low):
        levels.append("Master")
    if "special course" in low:
        levels.append("Special course")
    return levels or ["Bachelor", "Master"], sentence_case(raw) if raw else "Bachelor or master"


def parse_slide(z, part, label, fix, badges, logos, images, warnings):
    root = ET.fromstring(z.read(part))
    tree = root.find(f"{P}cSld/{P}spTree")
    shapes = []
    walk(tree, (0, 0, 1, 1), shapes, rels_for(z, part), fix)
    texts = [s for s in shapes if s["kind"] == "text"]
    for s in texts:
        s["paras"] = [p for p in s["paras"] if p["text"].upper() not in BOILERPLATE]
    texts = [s for s in texts if s["paras"]]
    texts.sort(key=lambda s: (round(s["box"]["y"], 1), s["box"]["x"]))

    # anchors
    level_shape = next((s for s in texts if any(LEVEL_RE.match(p["text"]) for p in s["paras"])), None)
    heading_ys = [s["box"]["y"] for s in texts if s["box"]["x"] < 4.5
                  and any(SECTION_RE.match(p["text"]) for p in s["paras"])]
    if not level_shape or not heading_ys:
        warnings.append(f"{label}: not a project slide (no PROJECT LEVEL or sections), skipped")
        return None
    top = level_shape["box"]["y"]
    first_heading = min(heading_ys)

    # level and title
    level_paras = level_shape["paras"]
    li = next(i for i, p in enumerate(level_paras) if LEVEL_RE.match(p["text"]))
    levels, level_text = parse_level(LEVEL_RE.match(level_paras[li]["text"]).group(1))
    title_lines = [p["text"] for p in level_paras[li + 1:]]
    title_shape = next((s for s in texts if s is not level_shape and s["box"]["w"] >= 5.5
                        and top <= s["box"]["y"] < first_heading - 0.05), None)
    if title_shape:
        title_lines += [p["text"] for p in title_shape["paras"]]
    title_lines = [strip_brackets(t) for t in title_lines if strip_brackets(t)]
    if not title_lines:
        warnings.append(f"{label}: no title found, slide skipped")
        return None
    title, subtitle = title_lines[0], ""
    for line in title_lines[1:]:
        prev = subtitle or title
        if not subtitle and title.endswith(":"):
            # "Main title:" / "explanation" on the next line reads best as title + subtitle.
            title, subtitle = title[:-1].rstrip(), line[:1].upper() + line[1:]
        elif prev.endswith(":") or line[0].islower() or not is_titlecase(prev):
            if subtitle:
                subtitle += " " + line
            else:
                title += " " + line
        elif not subtitle:
            subtitle = line
        else:
            subtitle += " " + line

    used = {id(level_shape), id(title_shape)}

    # right column: supervisors and collaboration
    right = [s for s in texts if id(s) not in used and s["box"]["x"] >= 4.9 and s["box"]["y"] < first_heading + 0.2]
    right_items = [(p["text"], id(s)) for s in right for p in s["paras"]]
    collab_text = " ".join(t for t, _ in right_items).lower()
    people, collaboration = parse_people(right_items, collab_text)
    used |= {id(s) for s in right}

    # sections
    left = [s for s in texts if id(s) not in used and s["box"]["y"] >= first_heading - 0.05 and s["box"]["w"] >= 4.5]
    sections, current = [], None
    for s in left:
        for p in s["paras"]:
            m = SECTION_RE.match(p["text"])
            if m:
                key, heading = SECTIONS[re.sub(r"\s+", " ", m.group(1).upper())]
                note = m.group(2).strip().strip("()").strip()
                current = {"key": key, "title": heading, "note": note[:1].upper() + note[1:], "paras": []}
                sections.append(current)
            elif current is not None:
                current["paras"].append(p)
    used |= {id(s) for s in left}
    for sec in sections:
        sec["blocks"] = build_blocks(sec.pop("paras"))
        if sec["key"] == "activities" and len(sec["blocks"]) > 1 and all(b["t"] == "p" for b in sec["blocks"]):
            sec["blocks"] = [{"t": "li", "text": b["text"], "lvl": 0, "sub": []} for b in sec["blocks"]]
    sections = [s for s in sections if s["blocks"]]

    # figure zone: everything left of the supervisors, between title and sections
    def in_zone(b):
        cx, cy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
        return cx < 5.15 and top + 0.25 < cy < first_heading

    project_badges, pics = [], []
    for s in shapes:
        if s["kind"] != "pic":
            continue
        data = z.read(s["part"])
        digest = hashlib.md5(data).hexdigest()
        if digest in logos or "logo" in s["descr"].lower():
            continue
        if digest in badges:
            src = images.publish(data, Path(s["part"]).suffix, 1, label)
            if src and all(b["src"] != src for b in project_badges):
                project_badges.append({"src": src, "label": badges[digest]})
            continue
        if in_zone(s["box"]):
            src = images.publish(data, Path(s["part"]).suffix, s["box"]["w"], label)
            if src:
                pics.append({**s, "src": src})

    overlays, caption = [], []
    for s in texts:
        if id(s) in used or not in_zone(s["box"]):
            continue
        paras = [p for p in s["paras"] if not is_placeholder(p["text"])]
        if not paras:
            continue
        if s["box"]["w"] >= 3.0:
            caption += [p["text"] for p in paras]
        elif pics:
            overlays.append({**s, "paras": paras})

    figure = None
    if pics:
        boxes = [p["box"] for p in pics] + [o["box"] for o in overlays]
        x0 = min(b["x"] for b in boxes)
        y0 = min(b["y"] for b in boxes)
        x1 = max(b["x"] + b["w"] for b in boxes)
        y1 = max(b["y"] + b["h"] for b in boxes)
        fw, fh = x1 - x0, y1 - y0
        rel = lambda b: {"x": round((b["x"] - x0) / fw * 100, 3), "y": round((b["y"] - y0) / fh * 100, 3),
                         "w": round(b["w"] / fw * 100, 3), "h": round(b["h"] / fh * 100, 3)}
        items = [{"type": "img", "src": p["src"], **rel(p["box"]),
                  **({"crop": {k: round(v, 4) for k, v in p["crop"].items()}} if p["crop"] else {})} for p in pics]
        for o in overlays:
            first = o["paras"][0]
            items.append({"type": "text", "text": "\n".join(p["text"] for p in o["paras"]), **rel(o["box"]),
                          "size": round((first["size"] or 10) / 72 / fw * 100, 3),
                          "color": "#" + first["color"] if first["color"] else None,
                          "bold": bool(first["bold"]),
                          "align": {"ctr": "center", "r": "right"}.get(first["align"], "left")})
        figure = {"ratio": round(fw / fh, 4), "items": items}
    else:
        warnings.append(f"{label}: no project figure found")

    # checks
    for s in people:
        if not s["email"]:
            warnings.append(f"{label}: supervisor '{s['name']}' has no email")
        elif not VALID_EMAIL_RE.match(s["email"]):
            warnings.append(f"{label}: email '{s['email']}' looks incomplete; fix it in tools/corrections.json")
    if not people:
        warnings.append(f"{label}: no supervisors found")
    blob = json.dumps([title, people, collaboration, sections], ensure_ascii=False)
    if "�" in blob:
        warnings.append(f"{label}: text contains a broken character (�); add a fix to tools/corrections.json")

    notes = notes_text(z, part)
    tags = re.search(r"^\s*tags?\s*:\s*(.+)$", notes, re.I | re.M)
    status = re.search(r"^\s*status\s*:\s*(.+)$", notes, re.I | re.M)

    return {
        "id": slugify(title),
        "title": title,
        "subtitle": subtitle,
        "level": levels,
        "levelText": level_text,
        "supervisors": people,
        "collaboration": collaboration,
        "sections": sections,
        "figure": figure,
        "caption": " ".join(caption),
        "badges": project_badges,
        "tags": [t.strip() for t in tags.group(1).split(",") if t.strip()] if tags else [],
        "status": status.group(1).strip().lower() if status else "open",
        "source": label,
    }


def stamp_assets():
    """Add ?v=<content hash> to the page's CSS/JS links so browsers never use stale copies."""
    index = SITE / "index.html"
    html = index.read_text("utf8")

    def stamp(m):
        path = SITE / m.group(2)
        if not path.exists():
            return m.group(0)
        return f'{m.group(1)}{m.group(2)}?v={hashlib.md5(path.read_bytes()).hexdigest()[:8]}"'

    new = re.sub(r'((?:src|href)=")((?:css|js|data)/[\w./-]+\.(?:css|js))(?:\?v=\w+)?"', stamp, html)
    if new != html:
        index.write_text(new, "utf8")


def main(paths):
    fix = Fix(load_json("corrections.json", {}))
    badges = load_json("badges.json", {})
    logos = set(load_json("logos.json", []))
    if not paths:
        paths = sorted((ROOT / "catalogue").glob("*.pptx"))
    paths = [Path(p) for p in paths if not Path(p).name.startswith("~$")]
    if not paths:
        sys.exit("No .pptx files found. Put the catalogue files in the catalogue/ folder.")

    if IMG_DIR.exists():
        shutil.rmtree(IMG_DIR)
    IMG_DIR.mkdir(parents=True)

    projects, warnings = [], []
    images = Images(warnings)
    for path in paths:
        with zipfile.ZipFile(path) as z:
            for n, part in enumerate(slide_parts(z), 1):
                label = f"{path.name} slide {n}"
                project = parse_slide(z, part, label, fix, badges, logos, images, warnings)
                if project:
                    projects.append(project)

    seen = {}
    for project in projects:
        n = seen.get(project["id"], 0)
        seen[project["id"]] = n + 1
        if n:
            project["id"] += f"-{n + 1}"

    out = SITE / "data" / "projects.js"
    out.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(projects, ensure_ascii=False, indent=1)
    out.write_text("// Generated by tools/build_catalogue.py. Do not edit by hand.\n"
                   f"window.PROJECTS = {body};\n", "utf8")

    stamp_assets()
    size = sum(f.stat().st_size for f in IMG_DIR.iterdir()) / 1e6
    print(f"Built {len(projects)} projects from {len(paths)} file(s) -> {out.relative_to(ROOT)} "
          f"({len(list(IMG_DIR.iterdir()))} images, {size:.1f} MB)")
    for w in warnings:
        print("  warning:", w)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main(sys.argv[1:])
