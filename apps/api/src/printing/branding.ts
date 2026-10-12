import { join } from 'node:path';

/** Shared print masthead. It repeats on new pages without obscuring the legal seller details. */
export function addPdfBranding(doc: PDFKit.PDFDocument): void {
  const draw = () => {
    // PDFKit may create a page in the middle of wrapped text; preserve its current text size.
    const textSize = (doc as PDFKit.PDFDocument & { _fontSize: number })._fontSize;
    const { left, right, top } = doc.page.margins;
    const width = doc.page.width - left - right;
    const compact = width < 300;
    const logoWidth = compact ? 40 : 48;
    doc.save();
    doc.image(join(__dirname, 'assets', 'voitto-logo.png'), left, top, { fit: [logoWidth, 36] });
    doc.font('body').fontSize(compact ? 10 : 12).fillColor('#81651e')
      .text('VOITTO VENTURES', left + logoWidth + 12, top + 10, { width: width - logoWidth - 12, characterSpacing: compact ? 0.5 : 1.5 });
    doc.moveTo(left, top + 42).lineTo(left + width, top + 42).lineWidth(0.5).strokeColor('#c5ab65').stroke();
    doc.restore();
    doc.font('body').fontSize(textSize).fillColor('#111827');
    doc.x = left;
    doc.y = top + 52;
  };
  draw();
  doc.on('pageAdded', draw);
}
