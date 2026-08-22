import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'npm:pdf-lib@1.17.1';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status: number, headers: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface WaiverPayload {
  name: string;
  email?: string;
  signedDate: string;
  signatureImage: string;
  dob?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  minorInfo?: string;
  guardianPrintName?: string;
  guardianSignatureImage?: string;
  guardianDate?: string;
  ownerEmail?: string;
  minorAgeThreshold?: number;
}

Deno.serve(async (req) => {
  const headers = corsHeaders();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, headers);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const b = (body ?? {}) as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const signedDate = typeof b.signedDate === 'string' ? b.signedDate : '';
  const signatureImage = typeof b.signatureImage === 'string' ? b.signatureImage : '';
  const ownerEmail = typeof b.ownerEmail === 'string' ? b.ownerEmail.trim() : '';

  if (!name) return json({ error: 'Missing required field: name' }, 400, headers);
  if (!signedDate) return json({ error: 'Missing required field: signedDate' }, 400, headers);
  if (!signatureImage.startsWith('data:image/png;base64,')) {
    return json({ error: 'Missing or invalid signature' }, 400, headers);
  }
  if (email && !EMAIL_PATTERN.test(email)) {
    return json({ error: 'Invalid email address' }, 400, headers);
  }
  if (ownerEmail && !EMAIL_PATTERN.test(ownerEmail)) {
    return json({ error: 'Invalid owner email' }, 400, headers);
  }

  const payload: WaiverPayload = {
    name,
    email: email || undefined,
    signedDate,
    signatureImage,
    dob: typeof b.dob === 'string' ? b.dob : undefined,
    phone: typeof b.phone === 'string' ? b.phone.trim() || undefined : undefined,
    address: typeof b.address === 'string' ? b.address.trim() || undefined : undefined,
    city: typeof b.city === 'string' ? b.city.trim() || undefined : undefined,
    state: typeof b.state === 'string' ? b.state.trim() || undefined : undefined,
    zip: typeof b.zip === 'string' ? b.zip.trim() || undefined : undefined,
    minorInfo: typeof b.minorInfo === 'string' ? b.minorInfo.trim() || undefined : undefined,
    guardianPrintName:
      typeof b.guardianPrintName === 'string' ? b.guardianPrintName.trim() || undefined : undefined,
    guardianSignatureImage:
      typeof b.guardianSignatureImage === 'string' &&
      b.guardianSignatureImage.startsWith('data:image/png;base64,')
        ? b.guardianSignatureImage
        : undefined,
    guardianDate: typeof b.guardianDate === 'string' ? b.guardianDate || undefined : undefined,
    ownerEmail: ownerEmail || undefined,
    minorAgeThreshold:
      typeof b.minorAgeThreshold === 'number' && b.minorAgeThreshold > 0
        ? b.minorAgeThreshold
        : 18,
  };

  const { data: insertedId, error: insertError } = await supabaseAdmin.rpc(
    'submit_waiver_signature',
    {
      p_name: payload.name,
      p_email: payload.email ?? null,
      p_signed_date: payload.signedDate,
      p_signature_image: payload.signatureImage,
      p_dob: payload.dob ?? null,
      p_phone: payload.phone ?? null,
      p_address: payload.address ?? null,
      p_city: payload.city ?? null,
      p_state: payload.state ?? null,
      p_zip: payload.zip ?? null,
      p_minor_info: payload.minorInfo ?? null,
      p_guardian_print_name: payload.guardianPrintName ?? null,
      p_guardian_signature_image: payload.guardianSignatureImage ?? null,
      p_guardian_date: payload.guardianDate ?? null,
    },
  );

  if (insertError) {
    console.log(JSON.stringify({ event: 'wv_insert_failed', message: insertError.message }));
    return json({ error: 'Could not save your waiver — please try again.' }, 500, headers);
  }

  const inserted = { id: insertedId as string };

  let pdfBytes: Uint8Array | null = null;
  try {
    pdfBytes = await buildWaiverPdf(payload);
  } catch (e) {
    console.log(
      JSON.stringify({ event: 'wv_pdf_failed', id: inserted.id, message: String(e) }),
    );
  }

  if (payload.email) {
    try {
      await sendWaiverEmail({
        toEmail: payload.email,
        bccEmail: payload.ownerEmail,
        name: payload.name,
        pdfBytes,
      });
    } catch (e) {
      console.log(
        JSON.stringify({ event: 'wv_email_failed', id: inserted.id, message: String(e) }),
      );
    }
  }

  return json({ success: true, id: inserted.id }, 201, headers);
});

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const WAIVER_TITLE = 'Participant Agreement, Release and Assumption of Risk';

const WAIVER_INTRO =
  'In consideration of the services of Alaska Unique Adventures LLC d/b/a Alaskan Adventure Haven, ' +
  'their agents, owners, officers, volunteers, employees, and all other persons or entities acting in any ' +
  'capacity on their behalf (hereinafter collectively referred to as "AUA"), I hereby agree to release, ' +
  'indemnify, and discharge AUA on behalf of myself, my spouse, my children, my parents, my heirs, assigns, ' +
  'personal representative and estate as follows:';

const WAIVER_ITEMS: string[] = [
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

async function buildWaiverPdf(data: WaiverPayload): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const maxWidth = pageWidth - margin * 2;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  function newPageIfNeeded(nextLineHeight: number) {
    if (y - nextLineHeight < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  }

  function drawLine(text: string, size: number, useFont: PDFFont) {
    newPageIfNeeded(size * 1.35);
    page.drawText(text, { x: margin, y, size, font: useFont, color: rgb(0, 0, 0) });
    y -= size * 1.35;
  }

  function drawWrapped(text: string, size: number, useFont: PDFFont, gapAfter: number, indent = 0) {
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

  const rows: Array<[string, string]> = [
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
    drawLine("Parent/Guardian Additional Indemnification", 12, boldFont);
    drawLine(`(Must be completed for participants under the age of ${data.minorAgeThreshold ?? 18})`, 9, font);
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

async function sendWaiverEmail(opts: {
  toEmail: string;
  bccEmail?: string;
  name: string;
  pdfBytes: Uint8Array | null;
}): Promise<void> {
  const host = Deno.env.get('SMTP_HOST');
  const port = Deno.env.get('SMTP_PORT');
  const username = Deno.env.get('SMTP_USERNAME');
  const password = Deno.env.get('SMTP_PASSWORD');
  const from = Deno.env.get('CONTACT_EMAIL_FROM');

  if (!host || !port || !username || !password || !from) {
    console.log(JSON.stringify({ event: 'wv_email_skipped_no_smtp_config' }));
    return;
  }

  const secure = (Deno.env.get('SMTP_SECURE') ?? 'true') !== 'false';

  const client = new SMTPClient({
    connection: {
      hostname: host,
      port: Number(port),
      tls: secure,
      auth: { username, password },
    },
  });

  const attachments = opts.pdfBytes
    ? [
        {
          filename: 'AUA_Signed_Waiver.pdf',
          content: bytesToBase64(opts.pdfBytes),
          encoding: 'base64' as const,
          contentType: 'application/pdf',
        },
      ]
    : [];

  try {
    await client.send({
      from: `Alaska Unique Adventures <${from}>`,
      to: opts.toEmail,
      bcc: opts.bccEmail || undefined,
      subject: 'Your Signed AUA Liability Waiver',
      content:
        `Hi ${opts.name},\n\n` +
        'Attached is a copy of your signed Participant Agreement, Release and Assumption of Risk for ' +
        'Alaska Unique Adventures.\n\n' +
        'Please keep this for your records.\n\n' +
        'Thank you,\nAlaska Unique Adventures',
      attachments,
    });
  } finally {
    await client.close();
  }
}
