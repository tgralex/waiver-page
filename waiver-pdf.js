/**
 * Client-side (browser) PDF generation for the signed waiver — a reference/demo
 * implementation for the "Download my waiver" button on the confirmation screen.
 *
 * This regenerates the exact same waiver PDF as the emailed copy, entirely in
 * the browser, from the data the customer just submitted (no network round-trip,
 * no edge function). It mirrors buildWaiverPdf() in
 * supabase/functions/wv-submit-waiver/index.ts almost line-for-line — same
 * legal text, same layout, same signature embedding — just written against the
 * browser build of pdf-lib (window.PDFLib) instead of Deno's npm: import.
 *
 * Why this lives in its own file instead of inline in index.html: it's meant
 * to be a swappable, demonstrable piece for whoever picks this project up next.
 * Options going forward:
 *   - Keep it as-is: client-side generation, zero extra backend load or cost.
 *   - Move it to the backend: delete this file, have wv-submit-waiver return
 *     the PDF bytes in its response for the button to download, or add a
 *     small dedicated "regenerate PDF" edge function that takes the same
 *     payload shape and returns PDF bytes without touching the database.
 * Whichever way it goes, keep the waiver text below in sync with the Deno
 * version if the legal text ever changes — there is no shared source between
 * the two today.
 *
 * Requires pdf-lib's browser build loaded first:
 *   <script src="https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>
 */

(function () {
  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  const PDF_MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  function formatPdfDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return dateStr || '';
    const [, year, month, day] = m;
    const monthIdx = parseInt(month, 10) - 1;
    if (monthIdx < 0 || monthIdx > 11) return dateStr;
    return `${PDF_MONTH_NAMES[monthIdx]} ${parseInt(day, 10)} ${year}`;
  }

  let waiverContentPromise = null;
  function loadWaiverContent() {
    if (!waiverContentPromise) {
      waiverContentPromise = fetch('./waiver-content.json').then((r) =>
        r.ok ? r.json() : Promise.reject(new Error('waiver-content.json not found'))
      );
    }
    return waiverContentPromise;
  }

  async function buildWaiverPdf(data) {
    const { title: WAIVER_TITLE, intro: WAIVER_INTRO, items: WAIVER_ITEMS, closing: WAIVER_CLOSING } =
      await loadWaiverContent();
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 54;
    const maxWidth = pageWidth - margin * 2;

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    function newPageIfNeeded(nextLineHeight) {
      if (y - nextLineHeight < margin) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
    }

    function drawLine(text, size, useFont) {
      newPageIfNeeded(size * 1.35);
      page.drawText(text, { x: margin, y, size, font: useFont, color: rgb(0, 0, 0) });
      y -= size * 1.35;
    }

    function drawWrapped(text, size, useFont, gapAfter, indent) {
      indent = indent || 0;
      const words = text.split(' ');
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        const width = useFont.widthOfTextAtSize(test, size);
        if (width > maxWidth - indent && line) {
          newPageIfNeeded(size * 1.3);
          page.drawText(line, { x: margin + indent, y, size, font: useFont, color: rgb(0, 0, 0) });
          y -= size * 1.3;
          line = word;
        } else {
          line = test;
        }
      }
      if (line) {
        newPageIfNeeded(size * 1.3);
        page.drawText(line, { x: margin + indent, y, size, font: useFont, color: rgb(0, 0, 0) });
        y -= size * 1.3;
      }
      y -= gapAfter;
    }

    drawLine(WAIVER_TITLE, 14, boldFont);
    y -= 8;

    drawWrapped(WAIVER_INTRO, 9.5, font, 8);

    WAIVER_ITEMS.forEach((item, idx) => {
      drawWrapped(`${idx + 1}. ${item}`, 9.5, font, 8, 12);
    });

    drawWrapped(WAIVER_CLOSING, 9.5, font, 10);

    y -= 6;
    drawLine('Participant Information', 12, boldFont);
    y -= 2;

    const rows = [
      ['Print Name', data.name],
      ['Date of Birth', formatPdfDate(data.dob || '')],
      ['Phone Number', data.phone || ''],
      ['Email', data.email || ''],
      ['Address', data.address || ''],
      ['City / State / Zip', `${data.city || ''}, ${data.state || ''} ${data.zip || ''}`.trim()],
      ['Date Signed', formatPdfDate(data.signedDate || '')],
    ];
    for (const [label, value] of rows) {
      drawLine(`${label}: ${value}`, 10, font);
    }

    y -= 8;
    drawLine('Signature of Participant', 9, font);
    const sigBytes = dataUrlToBytes(data.signatureImage);
    const sigImage = await pdfDoc.embedPng(sigBytes);
    const sigDims = sigImage.scale(1);
    const sigW = 180;
    const sigH = sigW * (sigDims.height / sigDims.width);
    newPageIfNeeded(sigH + 10);
    page.drawImage(sigImage, { x: margin, y: y - sigH, width: sigW, height: sigH });
    y -= sigH + 14;

    if (data.minorInfo || data.guardianSignatureImage || data.guardianPrintName) {
      y -= 6;
      drawLine('Parent/Guardian Additional Indemnification', 12, boldFont);
      drawLine(`(Must be completed for participants under the age of ${data.minorAgeThreshold || 18})`, 9, font);
      y -= 2;
      if (data.minorInfo) {
        drawWrapped(`Minor(s): ${data.minorInfo}`, 10, font, 6);
      }
      if (data.guardianPrintName) {
        drawLine(`Guardian Print Name: ${data.guardianPrintName}`, 10, font);
      }
      if (data.guardianDob) {
        drawLine(`Guardian Date of Birth: ${formatPdfDate(data.guardianDob)}`, 10, font);
      }
      if (data.guardianDate) {
        drawLine(`Guardian Date Signed: ${formatPdfDate(data.guardianDate)}`, 10, font);
      }
      if (data.guardianSignatureImage) {
        y -= 6;
        drawLine('Parent or Guardian Signature', 9, font);
        const gBytes = dataUrlToBytes(data.guardianSignatureImage);
        const gImage = await pdfDoc.embedPng(gBytes);
        const gDims = gImage.scale(1);
        const gW = 180;
        const gH = gW * (gDims.height / gDims.width);
        newPageIfNeeded(gH + 10);
        page.drawImage(gImage, { x: margin, y: y - gH, width: gW, height: gH });
        y -= gH + 10;
      }
    }

    return await pdfDoc.save();
  }

  async function downloadWaiverPdf(data, filename) {
    const bytes = await buildWaiverPdf(data);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'AUA_Signed_Waiver.pdf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  window.WaiverPDF = { buildWaiverPdf, downloadWaiverPdf };
})();
