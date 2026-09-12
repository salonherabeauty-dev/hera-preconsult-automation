import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '// HERA_CONTACT_REVIEW_GUARD_V2';
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`CONTACT_GUARD_SOURCE_CHANGED:${before.slice(0, 65)}`);
  return source.replace(before, after);
}
export function protectClient(source) {
  if (source.includes(MARKER)) {
    if (!source.includes("return 'review';") || !source.includes('CONTACT_RECHECK_FAILED') || !source.includes('isContactHeld(b)')) throw new Error('INCOMPLETE_CONTACT_GUARD');
    return source;
  }
  let result = once(source, "  function firstName(full) {", "  function isContactHeld(b) { return b?.preconsult_status?.workflow_status === 'manual_review'; }\n  function firstName(full) {");
  result = once(result, "    ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All Qualifying'],", "    ['completed', 'Completed'], ['review', 'Needs Review'], ['cancelled', 'Cancelled'], ['all', 'All Qualifying'],");
  result = once(result, "    if (isCancelled(b)) return { code:'cancelled', label:'Cancelled', rank:90 };", "    if (isCancelled(b)) return { code:'cancelled', label:'Cancelled', rank:90 };\n    if (isContactHeld(b)) return { code:'review', label:'Contact held · needs review', rank:60 };");
  result = once(result, "    if (isCancelled(b)) return 'cancelled';", "    if (isCancelled(b)) return 'cancelled';\n    if (isContactHeld(b)) return 'review';");
  result = once(result, "Every future qualifying appointment is already sent, has photos, or is completed. Nothing is sent automatically.", "No appointment is currently queued for contact. Check Needs Review for any held records. Nothing is sent automatically.");
  result = once(result, "    const passed = isPassed(b);", "    const passed = isPassed(b);\n    const contactHeld = isContactHeld(b) || isCancelled(b);");
  result = once(result, '<div class="drawer-body">', '<div class="drawer-body">\n        ${contactHeld ? \'<div class="mobile-warning">CONTACT HOLD: this record requires reconciliation or is cancelled. Do not contact the client from this booking. Staff notes remain available.</div>\' : \'\'}');
  result = once(result, "${mobileOk && !passed?'':'disabled'}", "${mobileOk && !passed && !contactHeld?'':'disabled'}");
  result = result.replaceAll("${passed?'disabled':''}", "${passed || contactHeld?'disabled':''}");
  result = once(result, "  async function workflow(b, action, extra = {}, advance = false) {", "  async function workflow(b, action, extra = {}, advance = false) {\n    if (isContactHeld(b) && action !== 'save_notes') return toast('Contact is held for reconciliation. Only staff notes can be changed.');");
  const originalOpen = [
    '  function openWhatsapp(b, text) {',
    "    if (isPassed(b)) return toast('This appointment has already passed. WhatsApp sending is blocked.');",
    '    const mobile = whatsappMobile(b);',
    "    if (!validWhatsapp(mobile)) return toast('WhatsApp number needs checking. Add a verified international number first.');",
    '    const url = `https://wa.me/${waPhone(mobile)}?text=${encodeURIComponent(text)}`;',
    "    window.open(url, 'hera-preconsult-whatsapp');",
    '  }',
  ].join('\n');
  const safeOpen = [
    '  async function openWhatsapp(b, text) {',
    "    if (isContactHeld(b) || isCancelled(b) || isPassed(b)) return toast('Contact is blocked for this booking. Review its current status.');",
    "    const target = window.open('about:blank', 'hera-preconsult-whatsapp');",
    "    if (!target) return toast('Allow the WhatsApp window, then try again.');",
    '    try {',
    "      const freshData = await api('/api/dashboard');",
    '      const fresh = freshData.bookings?.find((row) => row.id === b.id);',
    '      if (!fresh || !fresh.preconsult_status?.required || isContactHeld(fresh) || isCancelled(fresh) || isPassed(fresh)) {',
    "        target.close(); await loadData(true); return toast('Contact blocked: the current booking is cancelled, held, or no longer eligible.');",
    '      }',
    '      if (fresh.last_timely_event_at !== b.last_timely_event_at || Date.parse(fresh.appointment_at) !== Date.parse(b.appointment_at) || whatsappMobile(fresh) !== whatsappMobile(b)) {',
    "        target.close(); await loadData(true); return toast('The booking changed. Reopen it and review the message before contacting.');",
    '      }',
    '      const mobile = whatsappMobile(fresh);',
    "      if (!validWhatsapp(mobile)) { target.close(); return toast('Verify the WhatsApp number first.'); }",
    '      target.location.href = `https://wa.me/${waPhone(mobile)}?text=${encodeURIComponent(text)}`;',
    '    } catch (error) {',
    '      target.close();',
    "      console.warn('CONTACT_RECHECK_FAILED');",
    "      toast('Could not verify the current booking. Nothing was opened in WhatsApp. Please retry after sync recovers.');",
    '    }',
    '  }',
  ].join('\n');
  result = once(result, originalOpen, safeOpen);
  return MARKER + '\n' + result;
}
export function protectWorkflow(source) {
  if (source.includes(MARKER)) {
    if (!source.includes("status.workflow_status === 'manual_review'")) throw new Error('INCOMPLETE_SERVER_CONTACT_GUARD');
    return source;
  }
  return MARKER + '\n' + once(source, '    const now = new Date().toISOString();', [
    "    if (status.workflow_status === 'manual_review' && body.action !== 'save_notes') {",
    "      return Response.json({ ok: false, error: 'This booking is on contact hold pending reconciliation. Only staff notes can be changed.' }, { status: 409 });",
    '    }',
    '',
    '    const now = new Date().toISOString();',
  ].join('\n'));
}
export function applyContactSafety(root = process.cwd()) {
  // Both transforms must validate before either source is written. An upstream UI change fails the build closed.
  const clientPath = path.join(root, 'public/app.js');
  const serverPath = path.join(root, 'api/workflow.ts');
  const client = protectClient(fs.readFileSync(clientPath, 'utf8'));
  const server = protectWorkflow(fs.readFileSync(serverPath, 'utf8'));
  fs.writeFileSync(clientPath, client);
  fs.writeFileSync(serverPath, server);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) applyContactSafety();
