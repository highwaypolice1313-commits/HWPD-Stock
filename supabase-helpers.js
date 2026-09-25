/**
 * supabase-helpers.js
 * ---------------------------------------------------------
 * ตัวกลางแทน Google Apps Script backend เดิม — คุยกับ Supabase (Postgres)
 * โดยตรงจากเบราว์เซอร์ ใช้คู่กับ schema ที่ตั้งไว้แล้วใน Supabase SQL Editor
 *
 * รูปภาพทั้งหมด (ครุภัณฑ์ / จนท. / ตราครุฑ / สภาพพัสดุตอนยืม-คืน / อาการซ่อม) ยัง
 * อัปโหลดขึ้น Google Drive ผ่าน Apps Script ตัวเดิม (GAS_UPLOAD_URL ด้านล่าง) เหมือนระบบเดิม
 * ทุกประการ — ไม่ได้ขึ้น Supabase Storage เพื่อไม่ให้กินโควตาพื้นที่ฝั่ง Supabase
 * ตาราง Supabase เก็บแค่ "URL ของรูปบน Drive" เป็น text เท่านั้น
 *
 * วิธีใช้:
 *  1. ใส่ SUPABASE_URL / SUPABASE_ANON_KEY ของโปรเจกต์ตัวเองด้านล่าง
 *  2. GAS_UPLOAD_URL ด้านล่างใช้ URL เดิมจาก index.html (สคริปต์ที่มี action 'uploadImage' อยู่แล้ว)
 *  3. โหลดไฟล์นี้ "ก่อน" สคริปต์หลักของ index.html เสมอ
 *  4. ในสคริปต์หลัก แก้ apiGet/apiPost ให้เรียก supaApiGet/supaApiPost แทน
 *
 * แนวคิดการแปลงข้อมูล: ตาราง Supabase ใช้ชื่อคอลัมน์ภาษาอังกฤษ แต่โค้ดหน้าเว็บเดิม
 * ใช้ key เป็นภาษาไทย (ตามหัวคอลัมน์ Google Sheets เดิม) ฟังก์ชัน xxxToThai() ด้านล่าง
 * มีหน้าที่แปลงกลับไปมา เพื่อให้ไม่ต้องแก้โค้ดหน้าเว็บอีกหลายพันบรรทัด
 * ---------------------------------------------------------
 */

// ==================== CONFIG — แก้ตรงนี้ ====================
const SUPABASE_URL = 'https://fuwuwboakywjlrtqwcjh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1d3V3Ym9ha3l3amxydHF3Y2poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMjM1NzksImV4cCI6MjEwNTY5OTU3OX0.BLQAGxm4s9g-w0fMR952cfZNK7KbuBXvGdImvKEi-PE';

// สคริปต์ Google Apps Script ตัวเดิม (มี action 'uploadImage' อัปโหลดขึ้น Drive อยู่แล้ว)
// ใช้ค่าเดียวกับ API_URL ใน index.html เดิม — ถ้า deploy ใหม่ให้แก้ URL นี้เท่านั้น
const GAS_UPLOAD_URL = 'https://script.google.com/macros/s/AKfycbw9mgyNR0My7CPuRRX1bRStNcuv1O6nTSivhZssA8svIOOul0VW9v32_rhGwJBDOkp37A/exec';

// ต้องโหลด <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// ไว้ก่อนไฟล์นี้ ไม่งั้น window.supabase จะยังไม่มี
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==================== ID GENERATOR (แทน genId_ ฝั่ง GAS) ====================
function genId(prefix) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const rnd = Math.floor(Math.random() * 90 + 10);
  return prefix + '-' + ts + rnd;
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==================== LOCAL SESSION TOKEN ====================
function makeLocalToken(role) {
  const payload = { role, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 };
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}
function verifyLocalToken(token) {
  try {
    const payload = JSON.parse(decodeURIComponent(escape(atob(token))));
    if (!payload || !payload.role || Date.now() > payload.exp) return null;
    return payload.role;
  } catch (e) { return null; }
}

async function supaLoginWithRole(role, password) {
  const { data, error } = await sb.rpc('login_with_role', { p_role: role, p_password: password });
  if (error) throw new Error(error.message || 'เข้าสู่ระบบไม่สำเร็จ');
  if (!data) throw new Error('รหัสผ่านไม่ถูกต้อง');
  return { role, token: makeLocalToken(role), displayName: role === 'admin' ? 'แอดมิน' : 'ผู้ดูอย่างเดียว' };
}
function supaLoginAsViewer() {
  return { role: 'viewer', token: makeLocalToken('viewer'), displayName: 'ผู้ดูอย่างเดียว' };
}

// ==================== IMAGE UPLOAD — ขึ้น Google Drive ผ่าน Apps Script เดิม ====================
// รับ dataUrl (base64) แล้วส่งให้ GAS ตัวเดิมอัปโหลดขึ้น Drive เหมือนระบบก่อนย้าย
// คืนค่า { url } เป็น URL รูปบน Drive เพื่อเก็บลง Supabase เป็น text ธรรมดา
async function gasUploadImageToDrive(dataUrl, fileName) {
  if (!dataUrl) return { url: '' };
  if (!/^data:image\//i.test(dataUrl)) return { url: dataUrl };

  // ส่ง sessionToken/actorName ไปด้วย เพราะ GAS backend เดิมต้องใช้ยืนยันตัวตน
  const _st = (typeof state !== 'undefined') ? state : null;

  const res = await fetch(GAS_UPLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'uploadImage',
      sessionToken: _st ? _st.sessionToken : '',
      actorName: _st && _st.user ? _st.user.name : '',
      payload: { dataUrl, fileName: fileName || 'image' }
    })
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('เซิร์ฟเวอร์อัปโหลดรูปตอบกลับไม่ถูกต้อง'); }
  if (!j.ok) throw new Error(j.error || 'อัปโหลดรูปไม่สำเร็จ');
  return { url: j.data && j.data.url ? j.data.url : '' };
}

// ==================== FIELD MAPPING: DB row (English) <-> Thai keys ที่หน้าเว็บใช้ ====================

const assetToThai = r => ({
  'รหัสครุภัณฑ์': r.id, 'ชื่อครุภัณฑ์': r.name, 'หมวดหมู่': r.category, 'ยี่ห้อ/รุ่น': r.brand,
  'หมายเลขเครื่อง': r.serial, 'วันที่รับเข้า': r.received_date, 'มูลค่า(บาท)': r.value,
  'สถานะ': r.status, 'ผู้ครอบครอง/หน่วยงาน': r.holder, 'หน่วยงาน': r.unit, 'หมายเหตุ': r.note,
  'รูปภาพ(URL)': r.image_url, 'วันที่บันทึก': r.created_at, 'วันครบกำหนดตรวจสภาพ/ต่อทะเบียน': r.renewal_due,
  'ทะเบียนรถ': r.license_plate, 'หมายเลขตัวถัง': r.chassis_no
});

const auditToThai = r => ({
  'รหัสตรวจนับ': r.id, 'รหัสครุภัณฑ์': r.asset_id, 'ชื่อครุภัณฑ์': r.asset_name, 'ปีที่ตรวจ': r.year,
  'ผล': r.result, 'ผู้ตรวจ': r.inspector, 'วันที่ตรวจ': r.inspected_at, 'หมายเหตุ': r.note,
  'ผลตรวจ(A/D)': r.found_status, 'คะแนนสภาพ': r.condition_score,
  'วันที่ใช้งานครั้งสุดท้าย': r.last_used_date, 'ความเห็นคณะกรรมการ': r.committee_decision
});
const borrowToThai = r => ({
  'รหัสรายการ': r.id, 'รหัสครุภัณฑ์': r.asset_id, 'ชื่อครุภัณฑ์': r.asset_name, 'ผู้ยืม': r.borrower,
  'LINEUserId': r.borrower_line_id, 'วันที่ยืม': r.borrow_date, 'กำหนดคืน': r.due_date,
  'วันที่คืนจริง': r.return_date, 'สถานะ': r.status, 'ผู้อนุมัติ': r.approver, 'หมายเหตุ': r.note,
  'รหัสส่วนควบที่ยืม': r.component_ids, 'รูปสภาพ(ตอนยืม)': r.photo_out, 'รูปสภาพ(ตอนคืน)': r.photo_in
});
const maintToThai = r => ({
  'รหัสรายการ': r.id, 'รหัสครุภัณฑ์': r.asset_id, 'ชื่อครุภัณฑ์': r.asset_name, 'วันที่แจ้ง': r.report_date,
  'อาการ/ปัญหา': r.issue, 'ผู้แจ้ง': r.reporter, 'สถานะ': r.status, 'วันที่ซ่อมเสร็จ': r.finish_date,
  'ค่าใช้จ่าย(บาท)': r.cost, 'ผู้รับผิดชอบ': r.responsible, 'หมายเหตุ': r.note, 'รูปถ่ายปัญหา': r.photo
});
const componentToThai = r => ({
  'รหัสส่วนควบ': r.id, 'รหัสครุภัณฑ์หลัก': r.parent_id, 'ชื่อส่วนควบ': r.name, 'ประเภท': r.type,
  'หมายเลข/ซีเรียล': r.serial, 'สถานะ': r.status, 'หมายเหตุ': r.note, 'วันที่บันทึก': r.created_at
});
const userToThai = r => ({
  'รหัสจนท.': r.id, 'LINEUserId': r.line_user_id, 'ชื่อ-สกุล': r.name, 'ตำแหน่ง': r.position,
  'หน่วยงาน': r.unit, 'สิทธิ์': r.role, 'วันที่เพิ่ม': r.created_at, 'ชื่อผู้ใช้': r.username,
  'ยศ': r.rank, 'บทบาทเบิก-ยืม': r.memo_role, 'รูปถ่าย': r.photo
});
const activityToThai = r => ({
  'รหัส': r.id, 'วันที่-เวลา': r.created_at, 'ผู้ทำรายการ': r.actor, 'การกระทำ': r.action, 'รายละเอียด': r.detail
});
const memoToThai = r => ({
  'รหัสใบเบิก': r.id, 'เรื่อง': r.subject, 'ผู้ขอเบิก': r.requester_name, 'วันที่เอกสาร': r.doc_date,
  'เนื้อหาเอกสาร(HTML)': r.html, 'รหัสรายการยืม': r.borrow_id, 'สถานะ': r.status, 'ผู้สร้าง': r.created_by,
  'วันที่สร้าง': r.created_at, 'แก้ไขล่าสุด': r.updated_at
});

// ==================== DASHBOARD BUILDER (พอร์ตจาก buildDashboard_ ฝั่ง GAS) ====================
function buildDashboardJS(assets, borrow, maint, alertDays) {
  const byCategory = {}, byStatus = {};
  let totalValue = 0, dueRenewalCount = 0;
  const alertWindow = (alertDays == null || isNaN(Number(alertDays))) ? 30 : Number(alertDays);
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() + alertWindow);

  assets.forEach(a => {
    const cat = a['หมวดหมู่'] || 'อื่นๆ';
    const status = a['สถานะ'] || '';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    totalValue += Number(a['มูลค่า(บาท)']) || 0;
    const rd = a['วันครบกำหนดตรวจสภาพ/ต่อทะเบียน'];
    if (rd && status !== 'จำหน่ายแล้ว') {
      const d = new Date(rd);
      if (!isNaN(d) && d <= cutoff) dueRenewalCount++;
    }
  });

  const monthTrend = {};
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthTrend[d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')] = 0;
  }
  borrow.forEach(b => {
    if (!b['วันที่ยืม']) return;
    const d = new Date(b['วันที่ยืม']);
    if (isNaN(d)) return;
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (key in monthTrend) monthTrend[key]++;
  });

  return {
    totalAssets: assets.length,
    totalValue,
    borrowedCount: borrow.filter(b => b['สถานะ'] === 'กำลังยืม' || b['สถานะ'] === 'เกินกำหนด').length,
    overdueCount: borrow.filter(b => b['สถานะ'] === 'เกินกำหนด').length,
    pendingCount: borrow.filter(b => b['สถานะ'] === 'รออนุมัติ').length,
    repairCount: maint.filter(m => m['สถานะ'] !== 'ซ่อมเสร็จ').length,
    maintCostTotal: maint.reduce((s, m) => s + (Number(m['ค่าใช้จ่าย(บาท)']) || 0), 0),
    dueRenewalCount,
    byCategory, byStatus, monthTrend
  };
}

// ==================== ACTIVITY LOG ====================
async function logActivitySb(actor, action, detail) {
  try { await sb.from('activity_log').insert({ id: genId('LOG'), actor: actor || '-', action, detail: detail || '' }); }
  catch (e) { /* log ล้มเหลวไม่ควรทำให้งานหลักล้ม */ }
}

// ==================== GET-side actions ====================
const SETTING_KEYS = ['orgName', 'orgPhone', 'docNoPrefix', 'renewalAlertDays', 'garudaLogo','auditCommittee', 'auditPeriodStart', 'auditPeriodEnd', 'categoryUnits', 'assetCategories'];

async function sGetSystemSettings() {
  const { data, error } = await sb.from('system_settings').select('*');
  if (error) throw new Error(error.message);
  const s = { orgName: '', orgPhone: '', docNoPrefix: '', renewalAlertDays: 30, garudaLogo: '' , auditCommittee: '', auditPeriodStart: '', auditPeriodEnd: '', categoryUnits: '', assetCategories: '' };
  (data || []).forEach(row => { if (SETTING_KEYS.indexOf(row.key) !== -1) s[row.key] = row.value; });
  const days = Number(s.renewalAlertDays);
  s.renewalAlertDays = (s.renewalAlertDays !== '' && !isNaN(days) && days >= 0) ? days : 30;
  return s;
}

async function sGetAll() {
  const [assetsR, borrowR, maintR, componentsR, usersR] = await Promise.all([
    sb.from('assets').select('*').order('created_at', { ascending: true }),
    sb.from('borrow').select('*').order('created_at', { ascending: true }),
    sb.from('maint').select('*').order('created_at', { ascending: true }),
    sb.from('components').select('*'),
    sb.from('users').select('id,line_user_id,name,position,unit,role,rank,memo_role,photo,username,created_at')
  ]);
  [assetsR, borrowR, maintR, componentsR, usersR].forEach(r => { if (r.error) throw new Error(r.error.message); });

  const settings = await sGetSystemSettings();
  const assets = assetsR.data.map(assetToThai);
  const borrow = borrowR.data.map(borrowToThai);
  const maint = maintR.data.map(maintToThai);
  const components = componentsR.data.map(componentToThai);
  const users = usersR.data.map(userToThai);

  return {
    assets, borrow, maint, components, users, settings,
    dashboard: buildDashboardJS(assets, borrow, maint, settings.renewalAlertDays)
  };
}

async function sGetUsers() {
  const { data, error } = await sb.from('users')
    .select('id,line_user_id,name,position,unit,role,rank,memo_role,photo,username,created_at');
  if (error) throw new Error(error.message);
  return data.map(u => { const t = userToThai(u); t['มีรหัสผ่านแล้ว'] = false; return t; });
}
async function sGetMemos() {
  const { data, error } = await sb.from('memos').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data.map(memoToThai);
}
async function sGetActivityLog() {
  const { data, error } = await sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(300);
  if (error) throw new Error(error.message);
  return data.map(activityToThai);
}
async function sGetAuditRecords(year) {
  const y = Number(year) || new Date().getFullYear();
  const { data, error } = await sb.from('audit_records').select('*').eq('year', y);
  if (error) throw new Error(error.message);
  return data.map(auditToThai);
}

async function supaApiGet(action, params) {
  params = params || {};
  switch (action) {
    case 'getAll': return await sGetAll();
    case 'getUsers': return await sGetUsers();
    case 'getMemos': return await sGetMemos();
    case 'getActivityLog': return await sGetActivityLog();
    case 'getAuditRecords': return await sGetAuditRecords(params.year);
    case 'getSystemSettings': return await sGetSystemSettings();
    case 'validateSession': return { valid: !!verifyLocalToken(params.token) };
    default: throw new Error('ไม่รู้จัก action: ' + action);
  }
}

// ==================== POST-side actions ====================
async function setComponentsStatusSb(ids, status) {
  if (!ids || !ids.length) return;
  await sb.from('components').update({ status }).in('id', ids);
}

async function sAddAsset(p, actor) {
  const id = p.id || genId('AST');
  const row = {
  id, name: p.name, category: p.category, brand: p.brand || '', serial: p.serial || '',
  received_date: p.receivedDate || null, value: (p.value !== undefined && p.value !== '') ? Number(p.value) : null,
  status: p.status || 'พร้อมใช้งาน', holder: p.holder || '', unit: p.unit || '',
  note: p.note || '', image_url: p.imageUrl || '', renewal_due: p.renewalDue || null,
  license_plate: p.licensePlate || '', chassis_no: p.chassisNo || ''   // เพิ่มบรรทัดนี้
};
  const { error } = await sb.from('assets').insert(row);
  if (error) throw new Error('เพิ่มครุภัณฑ์ไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'เพิ่มครุภัณฑ์', p.name);
  return { id };
}
async function sUpdateAsset(p, actor) {
  const map = { name: 'name', category: 'category', brand: 'brand', serial: 'serial', receivedDate: 'received_date',
  value: 'value', status: 'status', holder: 'holder', unit: 'unit', note: 'note', imageUrl: 'image_url', renewalDue: 'renewal_due',
  licensePlate: 'license_plate', chassisNo: 'chassis_no' };   // เพิ่ม 2 ตัวนี้
  const upd = {};
  Object.keys(map).forEach(k => {
    if (p[k] === undefined) return;
    if (k === 'value') { upd.value = p[k] === '' ? null : Number(p[k]); return; }
    if ((k === 'receivedDate' || k === 'renewalDue') && p[k] === '') { upd[map[k]] = null; return; }
    upd[map[k]] = p[k];
  });
  const { error } = await sb.from('assets').update(upd).eq('id', p.id);
  if (error) throw new Error('แก้ไขครุภัณฑ์ไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'แก้ไขครุภัณฑ์', p.id);
  return { updated: true };
}
async function sDeleteAsset(id, actor) {
  const { error } = await sb.from('assets').delete().eq('id', id);
  if (error) throw new Error('ลบครุภัณฑ์ไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'ลบครุภัณฑ์', id);
  return { deleted: true };
}

async function sBorrowAsset(p, actor, directApprove) {
  const id = genId('BRW');
  const componentIds = Array.isArray(p.componentIds) ? p.componentIds : [];
  const status = directApprove ? 'กำลังยืม' : 'รออนุมัติ';
  const row = {
    id, asset_id: p.assetId, asset_name: p.assetName || '', borrower: p.borrower,
    borrower_line_id: p.borrowerLineId || '', borrow_date: p.borrowDate || null, due_date: p.dueDate || null,
    status, approver: p.approver || (directApprove ? actor : ''), note: p.note || '',
    component_ids: componentIds.join(','), photo_out: p.conditionPhotoOut || ''
  };
  const { error } = await sb.from('borrow').insert(row);
  if (error) throw new Error('บันทึกการยืมไม่สำเร็จ: ' + error.message);
  if (directApprove) {
    await sb.from('assets').update({ status: 'กำลังยืม', holder: p.borrower }).eq('id', p.assetId);
    await setComponentsStatusSb(componentIds, 'กำลังยืม');
  }
  await logActivitySb(actor, directApprove ? 'บันทึกการยืม (โดยแอดมิน)' : 'ขอยืมครุภัณฑ์', (p.assetName || '') + ' → ' + p.borrower);
  return { id, status };
}
async function sApproveBorrow(p, actor) {
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.borrowId).single();
  if (e1 || !b) throw new Error('ไม่พบคำขอยืมรหัส ' + p.borrowId);
  const { error } = await sb.from('borrow').update({ status: 'กำลังยืม', approver: actor }).eq('id', p.borrowId);
  if (error) throw new Error(error.message);
  await sb.from('assets').update({ status: 'กำลังยืม', holder: b.borrower }).eq('id', b.asset_id);
  const compIds = String(b.component_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  await setComponentsStatusSb(compIds, 'กำลังยืม');
  await logActivitySb(actor, 'อนุมัติการยืม', p.borrowId);
  return { approved: true };
}
async function sRejectBorrow(p, actor) {
  const { error } = await sb.from('borrow').update({ status: 'ถูกปฏิเสธ' }).eq('id', p.borrowId);
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'ปฏิเสธคำขอยืม', p.borrowId);
  return { rejected: true };
}
async function sReturnAsset(p, actor) {
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.borrowId).single();
  if (e1 || !b) throw new Error('ไม่พบรายการยืมรหัส ' + p.borrowId);
  const upd = { return_date: p.returnDate || new Date().toISOString().slice(0, 10), status: 'คืนแล้ว' };
  if (p.conditionPhotoReturn) upd.photo_in = p.conditionPhotoReturn;
  const { error } = await sb.from('borrow').update(upd).eq('id', p.borrowId);
  if (error) throw new Error(error.message);
  await sb.from('assets').update({ status: 'พร้อมใช้งาน', holder: '' }).eq('id', b.asset_id);
  const compIds = String(b.component_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  await setComponentsStatusSb(compIds, 'พร้อมใช้งาน');
  await logActivitySb(actor, 'บันทึกการคืน', p.borrowId);
  return { returned: true };
}

async function sUpdateBorrow(p, actor) {
  // ตรวจสอบก่อนว่ามีรายการยืมรหัสนี้อยู่จริงหรือไม่
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.id).single();
  if (e1 || !b) throw new Error('ไม่พบรายการยืมรหัส ' + p.id);

  // เตรียมข้อมูลที่จะอัปเดต — อัปเดตเฉพาะฟิลด์ที่ส่งมาเท่านั้น
  const upd = {};
  if (p.borrower !== undefined) upd.borrower = p.borrower;
  if (p.borrowDate !== undefined) upd.borrow_date = p.borrowDate || null;
  if (p.dueDate !== undefined) upd.due_date = p.dueDate || null;
  if (p.returnDate !== undefined) upd.return_date = p.returnDate || null;
  if (p.note !== undefined) upd.note = p.note;

  const { error } = await sb.from('borrow').update(upd).eq('id', p.id);
  if (error) throw new Error('แก้ไขข้อมูลการยืมไม่สำเร็จ: ' + error.message);

  // ถ้าเปลี่ยนชื่อผู้ยืม และครุภัณฑ์ตัวนี้ยังอยู่ในสถานะ "กำลังยืม" อยู่
  // ให้อัปเดตชื่อผู้ครอบครองในตารางครุภัณฑ์ (assets) ให้ตรงกันไปด้วย
  if (p.borrower !== undefined && b.status === 'กำลังยืม') {
    await sb.from('assets').update({ holder: p.borrower }).eq('id', b.asset_id);
  }

  await logActivitySb(actor, 'แก้ไขข้อมูลการยืม', p.id);
  return { updated: true };
}

async function sDeleteBorrow(p, actor) {
  // ตรวจสอบก่อนว่ามีรายการยืมรหัสนี้อยู่จริงหรือไม่
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.id).single();
  if (e1 || !b) throw new Error('ไม่พบรายการยืมรหัส ' + p.id);

  // ถ้ารายการนี้ยังไม่ได้คืน (สถานะ "กำลังยืม") ต้องคืนสถานะครุภัณฑ์และส่วนควบกลับเป็น "พร้อมใช้งาน" ก่อนลบ
  // ไม่งั้นครุภัณฑ์จะค้างสถานะ "กำลังยืม" ตลอดไปทั้งที่ไม่มีรายการยืมอ้างอิงอยู่แล้ว
  if (b.status === 'กำลังยืม') {
    await sb.from('assets').update({ status: 'พร้อมใช้งาน', holder: '' }).eq('id', b.asset_id);
    const compIds = String(b.component_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    await setComponentsStatusSb(compIds, 'พร้อมใช้งาน');
  }

  const { error } = await sb.from('borrow').delete().eq('id', p.id);
  if (error) throw new Error('ลบรายการไม่สำเร็จ: ' + error.message);

  await logActivitySb(actor, 'ลบรายการยืม-คืน', p.id);
  return { deleted: true };
}
async function sRenewBorrow(p, actor) {
  // ตรวจสอบก่อนว่ามีรายการยืมเดิมอยู่จริง และยังไม่ได้คืน
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.borrowId).single();
  if (e1 || !b) throw new Error('ไม่พบรายการยืมรหัส ' + p.borrowId);
  if (b.status !== 'กำลังยืม') throw new Error('ยืมต่อได้เฉพาะรายการที่ยังไม่คืนเท่านั้น');

  const today = new Date().toISOString().slice(0, 10);

  // ปิดรายการเดิมเป็น "คืนแล้ว" ณ วันนี้
  const { error: e2 } = await sb.from('borrow').update({ status: 'คืนแล้ว', return_date: today }).eq('id', p.borrowId);
  if (e2) throw new Error('ปิดรายการเดิมไม่สำเร็จ: ' + e2.message);

  // เปิดรายการยืมใหม่ให้ผู้ยืมคนเดิมทันที — ครุภัณฑ์ยังอยู่ในสถานะ "กำลังยืม" อยู่แล้ว ไม่ต้องแก้ไขอะไรเพิ่ม
  const newId = genId('BRW');
  const row = {
    id: newId, asset_id: b.asset_id, asset_name: b.asset_name, borrower: b.borrower,
    borrower_line_id: b.borrower_line_id || '', borrow_date: today, due_date: p.dueDate || null,
    status: 'กำลังยืม', approver: actor, note: p.note !== undefined ? p.note : (b.note || ''),
    component_ids: b.component_ids || '', photo_out: b.photo_out || ''
  };
  const { error: e3 } = await sb.from('borrow').insert(row);
  if (e3) throw new Error('เปิดรายการยืมใหม่ไม่สำเร็จ: ' + e3.message);

  await logActivitySb(actor, 'ยืมต่อ (คนเดิม)', b.borrower + ' → ' + b.asset_name);
  return { renewed: true, newId };
}

async function sAddMaint(p, actor) {
  const id = genId('MNT');
  const row = { id, asset_id: p.assetId, asset_name: p.assetName || '', report_date: p.reportDate || null,
    issue: p.issue, reporter: p.reporter || '', status: 'รอซ่อม', photo: p.photo || '' };
  const { error } = await sb.from('maint').insert(row);
  if (error) throw new Error('แจ้งซ่อมไม่สำเร็จ: ' + error.message);
  await sb.from('assets').update({ status: 'ซ่อมบำรุง' }).eq('id', p.assetId);
  await logActivitySb(actor, 'แจ้งซ่อมบำรุง', p.assetName);
  return { id };
}
async function sUpdateMaint(p, actor) {
  const upd = {};
  if (p.status !== undefined) upd.status = p.status;
  if (p.finishDate !== undefined) upd.finish_date = p.finishDate || null;
  if (p.cost !== undefined) upd.cost = p.cost === '' ? null : Number(p.cost);
  if (p.responsible !== undefined) upd.responsible = p.responsible;
  if (p.note !== undefined) upd.note = p.note;
  const { data: m, error: e1 } = await sb.from('maint').select('asset_id').eq('id', p.id).single();
  if (e1 || !m) throw new Error('ไม่พบรายการซ่อมรหัส ' + p.id);
  const { error } = await sb.from('maint').update(upd).eq('id', p.id);
  if (error) throw new Error(error.message);
  if (p.status === 'ซ่อมเสร็จ') await sb.from('assets').update({ status: 'พร้อมใช้งาน' }).eq('id', m.asset_id);
  await logActivitySb(actor, 'อัปเดตงานซ่อม', p.id);
  return { updated: true };
}

async function sAddComponent(p, actor) {
  const id = genId('CMP');
  const { error } = await sb.from('components').insert({ id, parent_id: p.parentId, name: p.name, type: p.type || '', serial: p.serial || '', status: 'พร้อมใช้งาน', note: p.note || '' });
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'เพิ่มส่วนควบ', p.name);
  return { id };
}
async function sUpdateComponent(p, actor) {
  const upd = {};
  ['name', 'type', 'serial', 'status', 'note'].forEach(k => { if (p[k] !== undefined) upd[k] = p[k]; });
  const { error } = await sb.from('components').update(upd).eq('id', p.id);
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'แก้ไขส่วนควบ', p.id);
  return { updated: true };
}
async function sDeleteComponent(id, actor) {
  const { error } = await sb.from('components').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'ลบส่วนควบ', id);
  return { deleted: true };
}

async function sAddUser(p, actor) {
  const id = genId('OFC');
  let photoUrl = '';
  if (p.photoData) photoUrl = (await gasUploadImageToDrive(p.photoData, 'user-' + id)).url;
  else if (p.photo) photoUrl = p.photo;
  const row = {
    id, line_user_id: p.lineUserId || '', name: p.name, position: p.position || '', unit: p.unit || '',
    role: p.role || 'viewer', rank: p.rank || '', memo_role: p.memoRole || 'ไม่ระบุ (เลือกเองตอนพิมพ์)',
    photo: photoUrl, username: p.username || ''
  };
  const { error } = await sb.from('users').insert(row);
  if (error) throw new Error('เพิ่มรายชื่อไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'เพิ่มรายชื่อ จนท.ในสังกัด', p.name);
  return { added: true, id };
}
async function sUpdateUserRole(p, actor) {
  let col = 'id', val = p.officerId;
  if (!val && p.lineUserId) { col = 'line_user_id'; val = p.lineUserId; }
  if (!val && p.username) { col = 'username'; val = p.username; }
  if (!val) throw new Error('ไม่พบผู้ใช้ที่ต้องการแก้ไข');
  const upd = {};
  if (p.name !== undefined) upd.name = p.name;
  if (p.position !== undefined) upd.position = p.position;
  if (p.unit !== undefined) upd.unit = p.unit;
  if (p.role !== undefined) upd.role = p.role;
  if (p.rank !== undefined) upd.rank = p.rank;
  if (p.memoRole !== undefined) upd.memo_role = p.memoRole;
  if (p.photoData) upd.photo = (await gasUploadImageToDrive(p.photoData, 'user-' + val)).url;
  else if (p.photo !== undefined) upd.photo = p.photo;
  const { error } = await sb.from('users').update(upd).eq(col, val);
  if (error) throw new Error('แก้ไขไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'แก้ไขข้อมูล จนท.', p.name || val);
  return { updated: true, photoUrl: upd.photo };
}
async function sDeleteUser(p, actor) {
  let q = sb.from('users').delete();
  if (p.officerId) q = q.eq('id', p.officerId);
  else if (p.identifier) q = q.or(`line_user_id.eq.${p.identifier},username.eq.${p.identifier},name.eq.${p.identifier}`);
  else throw new Error('ไม่พบตัวระบุผู้ใช้สำหรับลบ');
  const { error } = await q;
  if (error) throw new Error('ลบไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'ลบรายชื่อ จนท.', p.officerId || p.identifier);
  return { deleted: true };
}

async function sAddMemo(p, actor) {
  const id = genId('MEMO');
  const row = { id, subject: p.subject || 'ไม่ระบุเรื่อง', requester_name: p.requesterName || '', doc_date: p.docDate || '',
    html: p.html || '', borrow_id: p.borrowId || '', status: p.status || 'บันทึกแล้ว', created_by: actor || '' };
  const { error } = await sb.from('memos').insert(row);
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'บันทึกเอกสารใบเบิก', p.subject);
  return { id };
}
async function sUpdateMemo(p, actor) {
  const upd = { updated_at: new Date().toISOString() };
  if (p.subject !== undefined) upd.subject = p.subject;
  if (p.requesterName !== undefined) upd.requester_name = p.requesterName;
  if (p.docDate !== undefined) upd.doc_date = p.docDate;
  if (p.html !== undefined) upd.html = p.html;
  if (p.status !== undefined) upd.status = p.status;
  const { error } = await sb.from('memos').update(upd).eq('id', p.id);
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'แก้ไขเอกสารใบเบิก', p.subject || p.id);
  return { updated: true };
}
async function sDeleteMemo(id, actor) {
  const { error } = await sb.from('memos').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'ลบเอกสารใบเบิก', id);
  return { deleted: true };
}

async function sUpdateSystemSettings(p, actor) {
  const updates = {};
  if (p.orgName !== undefined) updates.orgName = String(p.orgName || '').trim();
  if (p.orgPhone !== undefined) updates.orgPhone = String(p.orgPhone || '').trim();
  if (p.docNoPrefix !== undefined) updates.docNoPrefix = String(p.docNoPrefix || '').trim();
  if (p.renewalAlertDays !== undefined && String(p.renewalAlertDays).trim() !== '') {
    const d = Number(p.renewalAlertDays);
    if (isNaN(d) || d < 0 || d > 3650) throw new Error('จำนวนวันแจ้งเตือนต้องเป็นตัวเลข 0 - 3650');
    updates.renewalAlertDays = Math.round(d);
  }
  if (p.garudaLogo !== undefined) {
    const logo = String(p.garudaLogo || '').trim();
    if (!logo) updates.garudaLogo = '';
    else if (/^data:image\//i.test(logo)) updates.garudaLogo = (await gasUploadImageToDrive(logo, 'garuda')).url;
    else updates.garudaLogo = logo;
  }
if (p.auditCommittee !== undefined) updates.auditCommittee = String(p.auditCommittee || '');
if (p.auditPeriodStart !== undefined) updates.auditPeriodStart = String(p.auditPeriodStart || '').trim();
if (p.auditPeriodEnd !== undefined) updates.auditPeriodEnd = String(p.auditPeriodEnd || '').trim();
if (p.categoryUnits !== undefined) updates.categoryUnits = String(p.categoryUnits || '');
if (p.assetCategories !== undefined) updates.assetCategories = String(p.assetCategories || '');

  // เปลี่ยนชื่อหมวดหมู่ในครุภัณฑ์ที่มีอยู่แล้วให้ตรงกับชื่อใหม่ (ทำก่อนบันทึกการตั้งค่า)
  if (p.categoryRenames !== undefined) {
    let renames = [];
    try { renames = JSON.parse(p.categoryRenames || '[]'); } catch (e) { renames = []; }
    for (const r of renames) {
      if (!r || !r.old || !r.new || r.old === r.new) continue;
      const { error: renameErr } = await sb.from('assets').update({ category: r.new }).eq('category', r.old);
      if (renameErr) throw new Error('เปลี่ยนชื่อหมวดหมู่ "' + r.old + '" ไม่สำเร็จ: ' + renameErr.message);
    }
  }
  
  for (const key of Object.keys(updates)) {
    const { error } = await sb.from('system_settings').upsert({ key, value: String(updates[key]), updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  await logActivitySb(actor, 'แก้ไขการตั้งค่าระบบ', '');
  return { updated: true, settings: await sGetSystemSettings() };
}

async function sSaveAuditRecord(p, actor) {
  const year = Number(p.year) || new Date().getFullYear();
  const { data: existing, error: e0 } = await sb.from('audit_records').select('id').eq('asset_id', p.assetId).eq('year', year).maybeSingle();
  if (e0) throw new Error('ตรวจสอบข้อมูลเดิมไม่สำเร็จ: ' + e0.message);

  const payload = {
    result: p.status || 'ยังไม่ตรวจ', inspector: actor || '', note: p.note || '',
    inspected_at: new Date().toISOString(),
    found_status: p.foundStatus || '', condition_score: p.conditionScore !== undefined && p.conditionScore !== '' ? Number(p.conditionScore) : null,
    last_used_date: p.lastUsedDate || null, committee_decision: p.committeeDecision || ''
  };

  if (existing) {
    const { error } = await sb.from('audit_records').update(payload).eq('id', existing.id);
    if (error) throw new Error('บันทึกผลตรวจไม่สำเร็จ: ' + error.message);
  } else {
    const { error } = await sb.from('audit_records').insert({ id: genId('AUD'), asset_id: p.assetId, asset_name: p.assetName || '', year, ...payload });
    if (error) throw new Error('บันทึกผลตรวจไม่สำเร็จ: ' + error.message);
  }

  await logActivitySb(actor, 'บันทึกผลตรวจนับยานพาหนะ', p.assetId + ' → ' + (p.status || ''));
  return { saved: true };
}

async function sChangeRolePassword(p) {
  const { data, error } = await sb.rpc('admin_set_role_password', { p_role: p.role, p_new_password: p.newPassword });
  if (error) throw new Error(error.message);
  return { updated: !!data };
}

const ADMIN_ACTIONS = ['addAsset', 'updateAsset', 'deleteAsset', 'borrowAsset', 'returnAsset', 'updateBorrow', 'deleteBorrow', 'renewBorrow',
  'approveBorrowRequest', 'rejectBorrowRequest', 'addMaint', 'updateMaint', 'addUser', 'updateUserRole',
  'deleteUser', 'addComponent', 'updateComponent', 'deleteComponent', 'deleteMemo', 'updateSystemSettings',
  'saveAuditRecord', 'migrateImagesToDrive', 'changeRolePassword'];
const AUTH_ACTIONS = ['requestBorrow', 'addMemo', 'updateMemo', 'uploadImage'];

async function supaApiPost(action, payload, role, actorName) {
  role = role || 'guest';
  payload = payload || {};
  if (ADMIN_ACTIONS.indexOf(action) !== -1 && role !== 'admin') throw new Error('ไม่มีสิทธิ์ทำรายการนี้ (ต้องเป็นแอดมิน)');
  if (AUTH_ACTIONS.indexOf(action) !== -1 && role === 'guest') throw new Error('กรุณาเข้าสู่ระบบก่อนทำรายการนี้');
  actorName = actorName || (role === 'admin' ? 'แอดมิน' : (role === 'viewer' ? 'ผู้ดูอย่างเดียว' : 'ไม่ทราบผู้ใช้'));

  switch (action) {
    case 'uploadImage': return await gasUploadImageToDrive(payload.dataUrl, payload.fileName);
    case 'addAsset': return await sAddAsset(payload, actorName);
    case 'updateAsset': return await sUpdateAsset(payload, actorName);
    case 'deleteAsset': return await sDeleteAsset(payload.id, actorName);
    case 'borrowAsset': return await sBorrowAsset(payload, actorName, true);
    case 'requestBorrow': return await sBorrowAsset(payload, actorName, false);
    case 'approveBorrowRequest': return await sApproveBorrow(payload, actorName);
    case 'rejectBorrowRequest': return await sRejectBorrow(payload, actorName);
    case 'returnAsset': return await sReturnAsset(payload, actorName);
    case 'updateBorrow': return await sUpdateBorrow(payload, actorName);
    case 'deleteBorrow': return await sDeleteBorrow(payload, actorName);
    case 'renewBorrow': return await sRenewBorrow(payload, actorName);
    case 'addMaint': return await sAddMaint(payload, actorName);
    case 'updateMaint': return await sUpdateMaint(payload, actorName);
    case 'addComponent': return await sAddComponent(payload, actorName);
    case 'updateComponent': return await sUpdateComponent(payload, actorName);
    case 'deleteComponent': return await sDeleteComponent(payload.id, actorName);
    case 'addUser': return await sAddUser(payload, actorName);
    case 'updateUserRole': return await sUpdateUserRole(payload, actorName);
    case 'deleteUser': return await sDeleteUser(payload, actorName);
    case 'addMemo': return await sAddMemo(payload, actorName);
    case 'updateMemo': return await sUpdateMemo(payload, actorName);
    case 'deleteMemo': return await sDeleteMemo(payload.id, actorName);
    case 'updateSystemSettings': return await sUpdateSystemSettings(payload, actorName);
    case 'saveAuditRecord': return await sSaveAuditRecord(payload, actorName);
    case 'migrateImagesToDrive': return { migrated: 0, failed: 0 };
    case 'changeRolePassword': return await sChangeRolePassword(payload);
    default: throw new Error('ไม่รู้จัก action: ' + action);
  }
}
