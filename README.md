# MSE Project Catalogue website

An interactive catalogue of bachelor and master projects offered by the Section of
Materials and Surface Engineering, DTU Construct. The projects come straight from the
catalogue PowerPoint: one slide per project.

```
catalogue/      the PowerPoint file(s) with the projects  <- this is what you edit
tools/          the script that reads the slides
site/           the website (published to GitHub Pages)
```

## Adding or changing projects

1. Add or edit slides in the PowerPoint in `catalogue/`, using the existing slide
   template. You can also put several `.pptx` files there (for example one per
   professor); all of them are read.
2. Rebuild the project data:

   ```
   python tools/build_catalogue.py
   ```

   It prints how many projects it found, plus warnings for anything it could not
   read (a missing email, a missing image, a broken character in a name).
3. Open `site/index.html` in a browser to check, then commit and push. The site
   rebuilds and republishes by itself.

When the repository is on GitHub you can skip step 2: upload the new PowerPoint
through the GitHub website and the workflow reads it and publishes the site.

### What the script reads from each slide

| On the slide | On the website |
|---|---|
| `PROJECT LEVEL: ...` (Master, MSc, Bachelor, BSc, BEng, special course) | Level filter and label |
| Title (a line ending in `:` followed by more text becomes title + subtitle) | Project title |
| SUPERVISORS: name, then email; optional "Lead supervisor" / "Co-supervisor" and affiliation lines | Supervisors with email links |
| COLLABORATION | Collaboration partners |
| PROJECT BACKGROUND, PROJECT AIM, PROJECT ACTIVITIES, PRACTICAL NOTES (numbered or not, with an optional note in brackets) | Project sections, with bullets and sub-points |
| Pictures, labels and caption to the left of the supervisors | The project figure, rebuilt as on the slide |

Text boxes are read by where they are on the slide, so moving them around or
adding extra ones is fine as long as the overall layout stays the same.

Optional lines in a slide's **speaker notes**:

```
Tags: simulation, tungsten, fusion
Status: taken
```

Tags make a project easier to find in search. `Status: taken` marks the project as
already assigned.

### Small fixes

- `tools/corrections.json` fixes text without editing the slides. Entries under
  `replace` change text anywhere (`Z�llner` becomes `Zöllner`); entries under
  `exact` replace a whole line (`baali@dtu.d` becomes `baali@dtu.dk`).
- `tools/image-cache/` holds web versions of figures that browsers can't show
  (TIFF, EMF) or that are very large. They are made on Windows the first time the
  script meets them. Commit this folder: GitHub's build runs on Linux and reuses them.
- `tools/badges.json` lists icons, such as the UN Sustainable Development Goal
  icons, that are shown as badges instead of as project figures. When the script
  meets an icon it doesn't know, it treats it as a figure.
- `tools/logos.json` lists images that are always skipped (the DTU logo).

## One combined PowerPoint

`tools/combine_catalogue.ps1` merges every file in `catalogue/` into
`combined/DTU_CONSTRUCT-MSE-Project_Catalogue-2026-2027 (all projects).pptx`,
keeping each slide's original formatting. It needs PowerPoint installed:

```
powershell -ExecutionPolicy Bypass -File tools\combine_catalogue.ps1
```

The combined file is kept outside `catalogue/` so the website doesn't list every
project twice. Pages in `front-pages/` (`01-cover.pptx`, `02-introduction.pptx`)
are placed before the projects, in file-name order.

The website offers the combined catalogue as a PDF download:
`site/downloads/MSE-Project-Catalogue-2026-2027.pdf`. After changing the combined
file, save it again as PDF to that path (in PowerPoint: File > Export > PDF) and
update the page count and size in the download link in `site/index.html`. GitHub
can't make the PDF (it has no PowerPoint), so commit the PDF with your changes.

## Publishing on GitHub Pages (one time)

1. Create a repository on GitHub and push this folder to its `main` branch.
2. In the repository, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. The next push publishes the site at `https://<user>.github.io/<repository>/`.

## Previewing locally

Opening `site/index.html` directly works. To preview over HTTP instead:

```
python -m http.server 8765 --directory site
```
