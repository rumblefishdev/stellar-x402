# SCF Submission — Documents & Build Pipeline

This directory holds the Stellar Community Fund **tranche verification** package for the x402
Facilitator with Bazaar for Stellar, and the toolchain that builds it. It follows the same
structure as `docs/scf/` in the Soroban Block Explorer and Stellar Prices API repositories.

## File inventory

| File                                                    | Role                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `milestone-1-evidence.md`                               | Full evidence companion to the M1 submission video — **source of truth**.                                         |
| `milestone-1-evidence.pdf`                              | PDF render of the above, uploaded to Google Drive next to the video. **Build output, not committed.**             |
| `milestone-1-video-scenario.md`                         | Scene-by-scene recording script for the 4–5 minute demo video.                                                    |
| `milestone-1-license-audit.md`                          | The dependency tree's license audit at the Tranche #1 boundary, with its commands.                                |
| `milestone-1-form-answers.md`                           | Text for each field of SCF's Build Tranche Completion form, and the pre-submission checklist.                     |
| `architecture.mmd`                                      | Mermaid source of the architecture diagram.                                                                       |
| `architecture.png`                                      | Rendered diagram, embedded in the PDF. **Build output.**                                                          |
| `build-pdf.sh`                                          | PDF render script (pandoc + typst).                                                                               |
| `screenshots/`                                          | Images the evidence document embeds, named after the deliverable (`d2-…`, `d5-…`).                                |
| `header.typ`, `full-width-tables.lua`, `repo-links.lua` | Typst and pandoc styling; `repo-links.lua` turns relative links into GitHub URLs at the `tranche-1-evidence` tag. |

## Build the PDF

One-time tooling install:

```bash
# macOS
brew install pandoc typst poppler

# Linux (Debian/Ubuntu)
sudo apt install pandoc poppler-utils
cargo install --locked typst-cli
```

`pandoc` must be ≥ 3.1 for `--pdf-engine=typst`; the script checks it.

```bash
./build-pdf.sh
```

Output: `milestone-1-evidence.pdf`. The script lists every unresolved `<TODO:>` marker.

## Render the architecture diagram

```bash
npx -y @mermaid-js/mermaid-cli -i architecture.mmd -o architecture.png -s 3 -p puppeteer-config.json
```

## Submission workflow

1. **Final deploy and gate rerun.** Deploy the finished Tranche 1 build, rerun the gate
   (`conformance/README.md`) and commit `conformance/results/testnet-hosted/` (task 0029).
2. **Outputs.** Run every command in `milestone-1-evidence.md` and paste its output over the
   `<TODO:>` marker; rebuild section 5.5's table from the rerun.
3. **Screenshots** for each `<TODO: screenshot>`, ideally in the same session as the recording.
4. **Tag** the commit on `develop` that holds the package and its results:
   `git tag tranche-1-evidence <commit> && git push origin tranche-1-evidence`. Every repository
   link in the PDF and in Field 3 points at it, so a later run or rename can't change what a
   reviewer sees.
5. **Render** the diagram, then `./build-pdf.sh`.
6. **Record** the video from `milestone-1-video-scenario.md`.
7. **Upload** the PDF and the video to one Google Drive folder, link-sharing "anyone with the link
   can view".
8. **Form.** Replace the placeholders in `milestone-1-form-answers.md`, work its checklist, paste
   the four fields into the form and submit.

## Ground rules for this package

- **Claim only what is demonstrated.** Tranche 1 is testnet. Mainnet, search, the MCP server, SDK
  helpers and `upto` in `/settle` are later tranches; section 7 of the evidence document and
  Field 1 say so.
- **The scope is Tranche #1 as approved:** the four line items of the Panel Review response's
  budget (§1) and its Tranche #1 conformance bar (§4), the same five items as
  `docs/planning/m1-epics.md`'s "T1 scope". Field 1 quotes them word for word.
- **Scope changes get disclosed, not buried.** A difference from the approved plan is named in the
  PDF and the video, and told to SCF before the submission.
- **One run, one set of numbers.** The PDF, the video and Field 1 quote the same gate rerun.
- **No secrets in any artifact:** no OpenBao tokens or IDs, server address, `.env` or RPC URLs, in
  the markdown, the PDF, the screenshots or any video frame.
- **No personal names, no Polish, no internal slang.** English only.
