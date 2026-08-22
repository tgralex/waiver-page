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

const WAIVER_TITLE = 'Participant Agreement, Release and Assumption of Risk';

const WAIVER_INTRO =
  'In consideration of the services of Alaska Unique Adventures LLC d/b/a Alaskan Adventure Haven, ' +
  'their agents, owners, officers, volunteers, employees, and all other persons or entities acting in any ' +
  'capacity on their behalf (hereinafter collectively referred to as "AUA"), I hereby agree to release, ' +
  'indemnify, and discharge AUA on behalf of myself, my spouse, my children, my parents, my heirs, assigns, ' +
  'personal representative and estate as follows:';

const WAIVER_ITEMS = [
  'I acknowledge that my participation in Guided Activities: Overnight Hiking, Camping, Backpacking, ' +
    'Watersport Activities-Canoe, Kayak, SUPs, Ski Trips - Cross Country Skiing and Snow Shoeing, Ice Skating ' +
    'as part of a Tour, Snow Hill Sledding, UTV, Snowmobiling, Ice Climbing activities all entail known and ' +
    'unanticipated risks that could result in physical or emotional injury, paralysis, death, or damage to ' +
    'myself, to property, or to third parties. I understand that such risks simply cannot be eliminated ' +
    'without jeopardizing the essential qualities of the activity. The risks include, among other things: ' +
    'slips and falls; falls from significant heights; the possibility of rough terrain; passengers can be ' +
    'jolted, jarred, bounced around, thrown about and otherwise shaken during rides; it is possible that ' +
    'riders could be injured if they come into contact with other passengers or equipment; injuries can be ' +
    'sustained from the trail, equipment or from items on the trail such as holes, bumps, ruts, obstacles, ' +
    'tree limbs and branches or rocks; riding on uneven and out of control terrain, changing snow conditions ' +
    'and variations in elevations; snow depth, instability of snow pack; steepness of slopes; loss of nature ' +
    'including extremes of weather, lightning and rapid weather changes, exposure to sun, strong wind, cold, ' +
    'large waves, eddies and whirlpools, tidal conditions, surf and currents; major injuries are a risk as ' +
    'are sprains, strains, scratches, bruises, abrasions, cuts, lacerations, broken bones, fractures, ' +
    'musculoskeletal injuries including head, neck, and back injuries; injuries to internal organs; loss of ' +
    'fingers or other appendages; exposure to the elements of the outdoors and natural surroundings which ' +
    'could cause heat exhaustion, heat stroke, sunburn, frostbite, frost nip, dehydration; and exposure to ' +
    'potentially dangerous wild animals, insect bites, and hazardous plant life; the negligence of ' +
    'participants, or other persons who may be present, or traveling in remote areas; or varying and ' +
    'difficult weather; further, passengers can be thrown off the vehicle which can result in any of the ' +
    'above events occurring; collision with fixed or movable objects; collisions, and flipping over; ' +
    'transmissible pathogen or disease; accidents or illness can occur in remote places without medical ' +
    'facilities and emergency treatment or other services rendered; any machine itself may fail; and ' +
    'accidents can occur getting in, out, on or off; traveling to and from activity locations raises the ' +
    'possibility of any manner of transportation accidents; additionally, fatigue, chill and/or dizziness ' +
    'may diminish my/our reaction time and increase the risk of an accident.',
  'I expressly agree and promise to accept and assume all of the risks existing in this activity. My ' +
    'participation in this activity is purely voluntary, and I elect to participate in spite of the risks. I ' +
    'agree to wear a properly fitted and secured DOT or SNELL certified helmet while participating in UTV, ' +
    'Snowmobiling, and Ice Climbing Activities. Additionally, I agree to wear a U.S. Coast Guard-approved ' +
    'personal flotation device (life jacket) while participating in all water activities.',
  'I hereby voluntarily release, forever discharge, and agree to indemnify and hold harmless AUA from any ' +
    'and all claims, demands, or causes of action, which are in any way connected with my participation in ' +
    'this activity or my use of AUA\'s equipment or facilities, including any such claims which allege ' +
    'negligent acts or omissions of AUA.',
  'Should AUA or anyone acting on their behalf be required to incur attorney\'s fees and costs to enforce ' +
    'this agreement, I agree to indemnify and hold them harmless for all such fees and costs.',
  'I certify that I have adequate insurance to cover any injury or damage I may cause or suffer while ' +
    'participating, or else I agree to bear the costs of such injury or damage myself. I further certify ' +
    'that I am willing to assume the risk of any medical or physical condition I may have.',
  'In the event that I file a lawsuit against AUA, I agree to do so solely in the state of Alaska, and I ' +
    'further agree that the substantive law of that state shall apply in that action without regard to the ' +
    'conflict of law rules of that state. I agree that if any portion of this agreement is found to be void ' +
    'or unenforceable, the remaining document shall remain in full force and effect.',
];

const WAIVER_CLOSING =
  'By signing this document, I acknowledge that if anyone is hurt or property is damaged during my ' +
  'participation in this activity, I may be found by a court of law to have waived my right to maintain a ' +
  'lawsuit against AUA on the basis of any claim from which I have released them herein. I also agree that ' +
  'this document is valid for subsequent visits and participation at AUA. I have had sufficient opportunity ' +
  'to read this entire document. I have read and understood it, and I agree to be bound by its terms.';

  async function buildWaiverPdf(data) {
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
      ['Date of Birth', data.dob || ''],
      ['Phone Number', data.phone || ''],
      ['Email', data.email || ''],
      ['Address', data.address || ''],
      ['City / State / Zip', `${data.city || ''}, ${data.state || ''} ${data.zip || ''}`.trim()],
      ['Date Signed', data.signedDate || ''],
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
      if (data.guardianDate) {
        drawLine(`Guardian Date: ${data.guardianDate}`, 10, font);
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
