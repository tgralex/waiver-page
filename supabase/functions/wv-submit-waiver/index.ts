import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'npm:pdf-lib@1.17.1';
import waiverContentJson from './waiver-content.json' with { type: 'json' };

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
  guardianDob?: string;
  guardianSignatureImage?: string;
  guardianDate?: string;
  ownerEmail?: string;
  minorAgeThreshold?: number;
}

// Statically imported from waiver-content.json, bundled alongside this
// function's source. Keeping the legal text out of code lets this project
// be reused for a different company by swapping one file, instead of
// editing the PDF-generation logic.
interface WaiverContent {
  title: string;
  intro: string;
  items: string[];
  closing: string;
}

const waiverContent = waiverContentJson as WaiverContent;
const { title: WAIVER_TITLE, intro: WAIVER_INTRO, items: WAIVER_ITEMS, closing: WAIVER_CLOSING } =
  waiverContent;

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
    guardianDob: typeof b.guardianDob === 'string' ? b.guardianDob || undefined : undefined,
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
      p_guardian_dob: payload.guardianDob ?? null,
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

const PDF_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function formatPdfDate(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return dateStr || '';
  const [, year, month, day] = m;
  const monthIdx = parseInt(month, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return dateStr;
  return `${PDF_MONTH_NAMES[monthIdx]} ${parseInt(day, 10)} ${year}`;
}

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
    drawLine("Parent/Guardian Additional Indemnification", 12, boldFont);
    drawLine(`(Must be completed for participants under the age of ${data.minorAgeThreshold ?? 18})`, 9, font);
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
