# Bundled assets

## NotoSansDevanagari-VF.ttf

The font the guest registration card embeds (`../grc-pdf.ts`). One family covers Latin, the rupee
sign and correctly shaped Devanagari, so the bilingual card needs a single embedded file.

- Source: <https://github.com/google/fonts/blob/main/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth,wght%5D.ttf>
- Licence: SIL Open Font License 1.1 — see `OFL.txt`
- SHA-256: `14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e`

**The file is pinned on purpose.** A registration card's SHA-256 is recorded in `grc_documents`, and
regenerating a card must reproduce the archived bytes exactly. A different font file changes the
embedded glyph programme and therefore every stored hash. `grc.test.ts` asserts the checksum above,
so replacing or upgrading the font is a deliberate change that fails the test first.

The variable font is embedded at its default instance (weight 400); the card uses size, colour and a
hairline stroke for emphasis rather than a second weight, which keeps one file in the artefact.
