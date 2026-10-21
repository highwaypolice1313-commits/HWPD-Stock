/**
 * supabase-helpers.js  (ฉบับแก้ไข: กันสถานะครุภัณฑ์เพี้ยนจากรายการยืม + ตรวจผล UPDATE ทุกจุด)
 * ---------------------------------------------------------
 * ตัวกลางแทน Google Apps Script backend เดิม — คุยกับ Supabase (Postgres)
 * โดยตรงจากเบราว์เซอร์ ใช้คู่กับ schema ที่ตั้งไว้แล้วใน Supabase SQL Editor
 *
 * รูปภาพทั้งหมด (ครุภัณฑ์ / จนท. / ตราครุฑ / สภาพพัสดุตอนยืม-คืน / อาการซ่อม) ยังคง
 * อัปโหลดขึ้น Google Drive ผ่าน Apps Script ตัวเดิม (GAS_UPLOAD_URL) ตาราง Supabase
 * เก็บแค่ "URL ของรูปบน Drive" เป็น text เท่านั้น
 *
 * การเปลี่ยนแปลงในฉบับนี้:
 *  - ทุกการเปลี่ยนสถานะครุภัณฑ์ผ่าน setAssetStatusSb() ซึ่งตรวจผลจริงและ throw เมื่อไม่สำเร็จ
 *  - ห้ามเปลี่ยนสถานะครุภัณฑ์ที่ยังมีรายการยืมค้างอยู่ (แก้ไขฟอร์ม / ปิดซ่อม / คืน / ลบรายการยืม)
 *  - กันการยืมซ้ำของครุภัณฑ์ที่ถูกยืมอยู่
 *  - หน้าแสดงผลซิงก์สถานะ "กำลังยืม" ตามรายการยืมที่ค้างอยู่เสมอ
 *
 * วิธีใช้:
 *  1. ตรวจว่า SUPABASE_URL / SUPABASE_ANON_KEY ตรงกับโปรเจกต์ของคุณ (ตรงจุด ⚠️ CONFIG)
 *  2. ตรวจว่ามี view v_* และ RPC soft_delete_item / restore_item / purge_item ใน Supabase แล้ว
 *  3. โหลดไฟล์นี้ "หลัง" <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *     และ "ก่อน" สคริปต์หลักของ index.html
 * ---------------------------------------------------------
 */

// ==================== ⚠️ CONFIG — แก้ตรงนี้ ====================
const SUPABASE_URL = 'https://fuwuwboakywjlrtqwcjh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1d3V3Ym9ha3l3amxydHF3Y2poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMjM1NzksImV4cCI6MjEwNTY5OTU3OX0.BLQAGxm4s9g-w0fMR952cfZNK7KbuBXvGdImvKEi-PE';

// สคริปต์ Google Apps Script ตัวเดิม (มี action 'uploadImage' / 'deleteImage' / 'listImages' / 'trashFiles')
// ถ้า deploy ใหม่ให้แก้ URL นี้เท่านั้น
const GAS_UPLOAD_URL = 'https://script.google.com/macros/s/AKfycbyT5Vwy1LrUt8tJmTEZ4wbYnUy2A80TMxb-is5E5SHp2ZTU1rHall6VZM_uL_7wnSr0/exec';
const GAS_UPLOAD_KEY = 'k8Xp2mQvR9tLw4NzY7bHc3Fd';

async function gasUploadImageToDrive(dataUrl, fileName) {
  if (!dataUrl) return { url: '' };
  if (!/^data:image\//i.test(dataUrl)) return { url: dataUrl };

  const res = await fetch(GAS_UPLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'uploadImage',
      uploadKey: GAS_UPLOAD_KEY,
      payload: { dataUrl, fileName: fileName || 'image' }
    })
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('เซิร์ฟเวอร์อัปโหลดรูปตอบกลับไม่ถูกต้อง'); }
  if (!j.ok) throw new Error(j.error || 'อัปโหลดรูปไม่สำเร็จ');
  return { url: j.data && j.data.url ? j.data.url : '' };
}

// ต้องโหลด supabase-js ไว้ก่อนไฟล์นี้ ไม่งั้น window.supabase จะยังไม่มี
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function todayStr() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

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

// บทบาทของผู้ใช้ปัจจุบันจากเซสชัน Supabase Auth (null ถ้าไม่มีเซสชันหรือบัญชีถูกปิด)
async function currentRoleSb() {
  const { data } = await sb.auth.getSession();
  if (!data || !data.session) return null;
  const { data: p } = await sb.from('profiles').select('role,active').eq('id', data.session.user.id).maybeSingle();
  if (!p || !p.active) return null;
  return p.role === 'admin' ? 'admin' : 'viewer';
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
async function supaLoginWithPin(pin) {
  const { data, error } = await sb.rpc('login_with_pin', { p_pin: pin });
  if (error) throw new Error(error.message);
  if (!data || !data.ok) throw new Error((data && data.error) || 'PIN ไม่ถูกต้อง');
  return { role: 'admin', token: makeLocalToken('admin'), displayName: 'แอดมิน' };
}

async function supaSetAdminPin(pin, currentPassword) {
  const { data, error } = await sb.rpc('set_my_pin', { p_pin: pin, p_current_password: currentPassword });
  if (error) throw new Error(error.message);
  if (!data || !data.ok) throw new Error((data && data.error) || 'บันทึก PIN ไม่สำเร็จ');
  return true;
}

async function supaDisableAdminPin(currentPassword) {
  const { data, error } = await sb.rpc('clear_my_pin', { p_current_password: currentPassword });
  if (error) throw new Error(error.message);
  if (!data || !data.ok) throw new Error((data && data.error) || 'ปิดการใช้ PIN ไม่สำเร็จ');
  return true;
}

// ==================== FIELD MAPPING: DB row (English) <-> Thai keys ที่หน้าเว็บใช้ ====================

const assetToThai = r => ({
  'รหัสครุภัณฑ์': r.id, 'ชื่อครุภัณฑ์': r.name, 'หมวดหมู่': r.category, 'ยี่ห้อ/รุ่น': r.brand,
  'หมายเลขเครื่อง': r.serial, 'วันที่รับเข้า': r.received_date, 'มูลค่า(บาท)': r.value,
  'สถานะ': r.status, 'ผู้ครอบครอง/หน่วยงาน': r.holder, 'หน่วยงาน': r.unit, 'หมายเหตุ': r.note,
  'รูปภาพ(URL)': r.image_url, 'วันที่บันทึก': r.created_at, 'วันครบกำหนดตรวจสภาพ/ต่อทะเบียน': r.renewal_due,
  'ทะเบียนรถ': r.license_plate, 'หมายเลขตัวถัง': r.chassis_no, 'หมายเลขเครื่องยนต์': r.engine_no,
  'ขนาดยาง': r.tire_size
});

const auditToThai = r => ({
  'รหัสตรวจนับ': r.id, 'รหัสครุภัณฑ์': r.asset_id, 'ชื่อครุภัณฑ์': r.asset_name, 'ปีที่ตรวจ': r.year,
  'ผล': r.result, 'ผู้ตรวจ': r.inspector, 'วันที่ตรวจ': r.inspected_at, 'หมายเหตุ': r.note,
  'ผลตรวจ(A/D)': r.found_status, 'คะแนนสภาพ': r.condition_score,
  'วันที่ใช้งานครั้งสุดท้าย': r.last_used_date, 'ความเห็นคณะกรรมการ': r.committee_decision
});
const borrowToThai = r => ({
  'รหัสรายการ': r.id, 'รหัสครุภัณฑ์': r.asset_id, 'ชื่อครุภัณฑ์': r.asset_name, 'ผู้ยืม': r.borrower,'รหัสจนท.ผู้ยืม': r.officer_id,
  'LINEUserId': r.borrower_line_id, 'วันที่ยืม': r.borrow_date, 'กำหนดคืน': r.due_date,
  'วันที่คืนจริง': r.return_date, 'สถานะ': r.status, 'ผู้อนุมัติ': r.approver, 'หมายเหตุ': r.note,
  'รหัสส่วนควบที่ยืม': r.component_ids, 'รูปสภาพ(ตอนยืม)': r.photo_out, 'รูปสภาพ(ตอนคืน)': r.photo_in,
  'ลายเซ็นผู้ยืม': r.sig_borrower, 'ลายเซ็นผู้อนุมัติ': r.sig_approver
});
const maintToThai = r => ({
  'รหัสรายการ': r.id, 'รหัสครุภัณฑ์': r.asset_id, 'ชื่อครุภัณฑ์': r.asset_name, 'วันที่แจ้ง': r.report_date,
  'อาการ/ปัญหา': r.issue, 'ผู้แจ้ง': r.reporter, 'สถานะ': r.status, 'วันที่ซ่อมเสร็จ': r.finish_date,
  'ค่าใช้จ่าย(บาท)': r.cost, 'ผู้รับผิดชอบ': r.responsible, 'หมายเหตุ': r.note, 'รูปถ่ายปัญหา': r.photo
});
const componentToThai = r => ({
  'รหัสส่วนควบ': r.id, 'รหัสครุภัณฑ์หลัก': r.parent_id, 'ชื่อส่วนควบ': r.name, 'ประเภท': r.type,
  'หมายเลข/ซีเรียล': r.serial, 'สถานะ': r.status, 'หมายเหตุ': r.note, 'วันที่บันทึก': r.created_at,
  'จำนวน': r.qty, 'จำนวนที่ยืมอยู่': r.qty_out
});
const userToThai = r => ({
  'รหัสจนท.': r.id, 'LINEUserId': r.line_user_id, 'ชื่อ-สกุล': r.name, 'ตำแหน่ง': r.position,
  'หน่วยงาน': r.unit, 'สิทธิ์': r.role, 'วันที่เพิ่ม': r.created_at, 'ชื่อผู้ใช้': r.username,
  'ยศ': r.rank, 'บทบาทเบิก-ยืม': r.memo_role, 'รูปถ่าย': r.photo, 'ลายเซ็น': r.signature,
  'เลขบัตรประชาชน': r.citizen_id, 'เบอร์โทร': r.phone, 'วัน/เดือน/ปีเกิด': r.birth_date,
  'กรุ๊ปเลือด': r.blood_type, 'auth_user_id': r.auth_user_id,
  'รหัสเปรียบเทียบปรับ': r.badge_no // ✅ เพิ่มบรรทัดนี้
});
const activityToThai = r => ({
  'รหัส': r.id, 'วันที่-เวลา': r.created_at, 'ผู้ทำรายการ': r.actor, 'การกระทำ': r.action, 'รายละเอียด': r.detail
});
const memoToThai = r => ({
  'รหัสใบเบิก': r.id, 'เรื่อง': r.subject, 'ผู้ขอเบิก': r.requester_name, 'วันที่เอกสาร': r.doc_date,
  'เนื้อหาเอกสาร(HTML)': r.html, 'รหัสรายการยืม': r.borrow_id, 'สถานะ': r.status, 'ผู้สร้าง': r.created_by,
  'วันที่สร้าง': r.created_at, 'แก้ไขล่าสุด': r.updated_at
});
const monthlyToThai = r => ({
  'รหัสตรวจ': r.id, 'ปี': r.year, 'เดือน': r.month, 'รหัสจนท.': r.officer_id,
  'ชื่อผู้ถูกตรวจ': r.officer_name, 'ผล': r.result, 'หมายเหตุ': r.note,
  'พัสดุที่ถือ': r.holdings_snapshot, 'ผู้ตรวจ': r.inspector, 'วันที่ตรวจ': r.inspected_at
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
const SETTING_KEYS = ['orgName', 'orgPhone', 'docNoPrefix', 'docNoNext', 'renewalAlertDays', 'garudaLogo', 'auditCommittee', 'auditPeriodStart', 'auditPeriodEnd', 'categoryUnits', 'assetCategories', 'categoryIcons', 'memoAddressee','oilDocNoPrefix', 'oilDocNoNext'];

async function sGetSystemSettings() {
  const { data, error } = await sb.from('system_settings').select('*');
  if (error) throw new Error(error.message);
  const s = { orgName: '', orgPhone: '', docNoPrefix: '', docNoNext: '', renewalAlertDays: 30, garudaLogo: '', auditCommittee: '', auditPeriodStart: '', auditPeriodEnd: '', categoryUnits: '', assetCategories: '', categoryIcons: '', memoAddressee: '' };
  (data || []).forEach(row => { if (SETTING_KEYS.indexOf(row.key) !== -1) s[row.key] = row.value; });
  const days = Number(s.renewalAlertDays);
  s.renewalAlertDays = (s.renewalAlertDays !== '' && !isNaN(days) && days >= 0) ? days : 30;
  return s;
}

// ดึงข้อมูลทีละ 1000 แถว (ใช้ได้ทั้งตารางจริงและ view)
async function fetchAll(table, columns = '*', orderCol) {
  const size = 1000; let from = 0, out = [];
  while (true) {
    let q = sb.from(table).select(columns).range(from, from + size - 1);
    if (orderCol) q = q.order(orderCol, { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(table + ': ' + error.message);
    out = out.concat(data || []);
    if (!data || data.length < size) break;
    from += size;
  }
  return out;
}

async function sGetAll() {
  // อ่านจาก view ทั้งหมด (view จะกรองรายการที่อยู่ในถังขยะออกให้แล้ว)
  const [assetsD, borrowD, maintD, componentsD, usersD] = await Promise.all([
    fetchAll('v_assets', '*', 'created_at'),
    fetchAll('v_borrow', '*', 'created_at'),
    fetchAll('v_maint', '*', 'created_at'),
    fetchAll('v_components', '*', 'created_at'),
    fetchAll('v_users', 'id,line_user_id,name,position,unit,role,rank,memo_role,photo,username,created_at,signature,badge_no,birth_date,auth_user_id', 'created_at')
  ]);
  const settings = await sGetSystemSettings();
  const assets = assetsD.map(assetToThai);
  const borrow = borrowD.filter(r => !r.deleted_at).map(borrowToThai);
  const maint = maintD.map(maintToThai);
  const components = componentsD.map(componentToThai);
  const users = usersD.map(userToThai);
  markOverdue(borrow);

  // ✅ แสดงสถานะ "กำลังยืม" ตามรายการยืมที่ค้างอยู่เสมอ แม้ตารางครุภัณฑ์จะไม่ตรงกัน
  const activeBorrowedIds = new Set(
    borrow
      .filter(b => b['สถานะ'] === 'กำลังยืม' || b['สถานะ'] === 'เกินกำหนด')
      .map(b => b['รหัสครุภัณฑ์'])
  );
  assets.forEach(a => {
    if (activeBorrowedIds.has(a['รหัสครุภัณฑ์']) && a['สถานะ'] === 'พร้อมใช้งาน') {
      a['สถานะ'] = 'กำลังยืม';
    }
  });

  return {
    assets, borrow, maint, components, users, settings,
    dashboard: buildDashboardJS(assets, borrow, maint, settings.renewalAlertDays)
  };
}

async function sGetUsers() {
  const { data, error } = await sb.from('v_users')
    .select('id,line_user_id,name,position,unit,role,rank,memo_role,photo,username,created_at,signature');
  if (error) throw new Error(error.message);
  return data.map(u => { const t = userToThai(u); t['มีรหัสผ่านแล้ว'] = false; return t; });
}
async function sGetMemos() {
  const { data, error } = await sb.from('v_memos').select('*').order('created_at', { ascending: false });
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
async function sGetMonthlyChecks(year, month) {
  const y = Number(year) || new Date().getFullYear();
  const m = Number(month) || (new Date().getMonth() + 1);
  const { data, error } = await sb.from('monthly_checks').select('*').eq('year', y).eq('month', m);
  if (error) throw new Error(error.message);
  return data.map(monthlyToThai);
}

// ==================== ถังขยะ (อ่าน) ====================
const TRASH_TABLES = ['assets', 'borrow', 'maint', 'memos', 'users', 'components'];
const TRASH_RETENTION_DAYS = 30;

async function sListTrash(role) {
  if (role !== 'admin') throw new Error('ไม่มีสิทธิ์');
  const out = [];
  for (const t of TRASH_TABLES) {
    // อ่านจากตารางจริง เพราะ view กรองรายการที่ลบแล้วออกไป
    const { data, error } = await sb.from(t).select('*').not('deleted_at', 'is', null);
    if (error) throw new Error(t + ': ' + error.message);
    (data || []).forEach(r => {
      const at = new Date(r.deleted_at).getTime();
      out.push({
        sheet: t,
        id: r.id,
        title: r.name || r.asset_name || r.borrower || r.subject || r.id,
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by || '-',
        daysLeft: Math.max(0, Math.ceil((at + TRASH_RETENTION_DAYS * 86400000 - Date.now()) / 86400000))
      });
    });
  }
  return out.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
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
    case 'validateSession': {
      // ตรวจจากเซสชัน Supabase Auth จริง (โทเค็นแบบเก่าใช้ไม่ได้แล้ว)
      const role = await currentRoleSb();
      return { valid: !!role, role };
    }
    case 'getMonthlyChecks': return await sGetMonthlyChecks(params.year, params.month);
    case 'listTrash': {
      // อ่าน role จาก token ฝั่งเซิร์ฟเวอร์ ไม่รับจาก client
      const role = await currentRoleSb();
      return await sListTrash(role);
    }
    default: throw new Error('ไม่รู้จัก action: ' + action);
  }
}

// ==================== POST-side helpers ====================
// "CMP-123:2,CMP-456" -> [{id:'CMP-123', n:2}, {id:'CMP-456', n:1}]
function parseCompRefs(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [id, n] = s.split(':');
    return { id: id.trim(), n: Math.max(1, parseInt(n, 10) || 1) };
  });
}
// sign = +1 ตอนยืม, -1 ตอนคืน/ลบรายการ
async function adjustComponentsSb(refs, sign) {
  if (!refs || !refs.length) return;
  const { data } = await sb.from('components').select('id,qty,qty_out').in('id', refs.map(r => r.id));
  for (const c of (data || [])) {
    const r = refs.find(x => x.id === c.id);
    const q = c.qty || 1;
    const out = Math.min(q, Math.max(0, (c.qty_out || 0) + sign * r.n));
    await sb.from('components').update({ qty_out: out, status: out >= q ? 'กำลังยืม' : 'พร้อมใช้งาน' }).eq('id', c.id);
  }
}

// เรียก RPC soft_delete_item (ย้ายรายการลงถังขยะ)
async function softDeleteSb(table, id, actor, role) {
  const { data, error } = await sb.rpc('soft_delete_item', {
    p_table: table, p_id: id, p_actor: actor, p_role: role
  });
  if (error) throw new Error(error.message);
  return data;
}

// ==================== ASSET STATUS GUARDS (ตัวช่วยกันสถานะเพี้ยน) ====================

// ✅ ตรวจว่าครุภัณฑ์มีรายการยืมที่ยังไม่คืน (ไม่นับรายการในถังขยะ) — ถ้าอ่านไม่ได้จะ throw
async function hasActiveBorrowSb(assetId) {
  const { data, error } = await sb.from('borrow').select('id')
    .eq('asset_id', assetId)
    .in('status', ['กำลังยืม', 'เกินกำหนด'])
    .is('deleted_at', null)
    .limit(1);
  if (error) throw new Error('ตรวจสอบรายการยืมไม่สำเร็จ: ' + error.message);
  return !!(data && data.length);
}

// ✅ อัปเดตสถานะครุภัณฑ์และตรวจผลจริง (กันกรณี RLS ทำให้ล้มเหลวเงียบ ๆ)
async function setAssetStatusSb(assetId, status, holder) {
  const upd = { status };
  if (holder !== undefined) upd.holder = holder;
  const { data, error } = await sb.from('assets').update(upd).eq('id', assetId).select('id');
  if (error) throw new Error('อัปเดตสถานะครุภัณฑ์ไม่สำเร็จ: ' + error.message);
  if (!data || !data.length) {
    throw new Error('อัปเดตสถานะครุภัณฑ์ไม่สำเร็จ: ไม่พบรหัส ' + assetId + ' หรือไม่มีสิทธิ์แก้ไข');
  }
}

// ==================== ASSETS ====================
async function sAddAsset(p, actor) {
  const id = p.id || genId('AST');
  const row = {
    id, name: p.name, category: p.category, brand: p.brand || '', serial: p.serial || '',
    received_date: p.receivedDate || null,
    value: (p.value !== undefined && p.value !== '') ? Number(p.value) : null,
    status: p.status || 'พร้อมใช้งาน', holder: p.holder || '', unit: p.unit || '',
    note: p.note || '', image_url: p.imageUrl || '', renewal_due: p.renewalDue || null,
    license_plate: p.licensePlate || '', chassis_no: p.chassisNo || '',
    engine_no: p.engineNo || '', tire_size: p.tireSize || ''
  };
  const { error } = await sb.from('assets').insert(row);
  if (error) throw new Error('เพิ่มครุภัณฑ์ไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'เพิ่มครุภัณฑ์', p.name);
  return { id };
}

async function sUpdateAsset(p, actor) {
  const map = {
    name: 'name', category: 'category', brand: 'brand', serial: 'serial', receivedDate: 'received_date',
    value: 'value', status: 'status', holder: 'holder', unit: 'unit', note: 'note', imageUrl: 'image_url',
    renewalDue: 'renewal_due', licensePlate: 'license_plate', chassisNo: 'chassis_no',
    engineNo: 'engine_no', tireSize: 'tire_size'
  };
  const upd = {};
  Object.keys(map).forEach(k => {
    if (p[k] === undefined) return;
    if (k === 'value') { upd.value = p[k] === '' ? null : Number(p[k]); return; }
    if ((k === 'receivedDate' || k === 'renewalDue') && p[k] === '') { upd[map[k]] = null; return; }
    upd[map[k]] = p[k];
  });

  // ✅ ห้ามเปลี่ยนสถานะครุภัณฑ์ที่ยังมีรายการยืมค้างอยู่
  // เช็คเฉพาะตอนที่สถานะถูกเปลี่ยนจริง เพื่อให้ฟอร์มแก้ไขที่ส่งค่าเดิมมายังบันทึกได้ตามปกติ
  if (p.status !== undefined) {
    const { data: cur, error: eCur } = await sb.from('assets').select('status').eq('id', p.id).maybeSingle();
    if (eCur) throw new Error('อ่านข้อมูลครุภัณฑ์ไม่สำเร็จ: ' + eCur.message);
    if (cur && cur.status !== p.status && p.status !== 'กำลังยืม' && await hasActiveBorrowSb(p.id)) {
      throw new Error('ครุภัณฑ์นี้ยังมีรายการยืมค้างอยู่ ต้องคืนก่อนจึงเปลี่ยนเป็น "' + p.status + '" ได้');
    }
  }

  const { error } = await sb.from('assets').update(upd).eq('id', p.id);
  if (error) throw new Error('แก้ไขครุภัณฑ์ไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'แก้ไขครุภัณฑ์', p.id);
  return { updated: true };
}

// ลบครุภัณฑ์ = ย้ายไปถังขยะ (ยังไม่ลบรูปบน Drive จนกว่าจะ purge ถาวร)
async function sDeleteAsset(id, actor, role) {
  // ✅ ห้ามลบครุภัณฑ์ที่ยังถูกยืมอยู่ เพื่อไม่ให้รายการยืมค้างชี้ไปที่ของที่ไม่อยู่ในทะเบียน
  if (await hasActiveBorrowSb(id)) {
    throw new Error('ครุภัณฑ์นี้ยังมีรายการยืมค้างอยู่ ต้องคืนก่อนจึงจะลบได้');
  }
  await softDeleteSb('assets', id, actor, role);
  await logActivitySb(actor, 'ลบครุภัณฑ์ (ไปถังขยะ)', id);
  return { deleted: true };
}

// ==================== BORROW ====================
async function sBorrowAsset(p, actor, directApprove) {
  const id = genId('BRW');
  const componentIds = Array.isArray(p.componentIds) ? p.componentIds : [];
  const status = directApprove ? 'กำลังยืม' : 'รออนุมัติ';

  // ✅ กันการยืมซ้ำ: แอดมินบันทึกยืมได้เฉพาะเมื่อครุภัณฑ์ไม่ได้ถูกยืมอยู่
  if (directApprove && await hasActiveBorrowSb(p.assetId)) {
    throw new Error('ครุภัณฑ์นี้ถูกยืมอยู่แล้ว ต้องคืนก่อนจึงจะยืมใหม่ได้');
  }

  const row = {
    id, asset_id: p.assetId, asset_name: p.assetName || '', borrower: p.borrower, officer_id: p.officerId || null,
    borrower_line_id: p.borrowerLineId || '', borrow_date: p.borrowDate || null, due_date: p.dueDate || null,
    status, approver: p.approver || (directApprove ? actor : ''), note: p.note || '',
    component_ids: componentIds.join(','), photo_out: p.conditionPhotoOut || '',
    sig_borrower: p.sigBorrower || '',
    sig_approver: directApprove ? (p.sigApprover || '') : ''
  };
  const { error } = await sb.from('borrow').insert(row);
  if (error) throw new Error('บันทึกการยืมไม่สำเร็จ: ' + error.message);

  if (directApprove) {
    try {
      await setAssetStatusSb(p.assetId, 'กำลังยืม', p.borrower);
    } catch (e) {
      // ✅ ถ้าอัปเดตสถานะไม่สำเร็จ ให้ลบรายการยืมที่เพิ่งสร้าง เพื่อไม่ให้ข้อมูลไม่ตรงกัน
      await sb.from('borrow').delete().eq('id', id);
      throw e;
    }
    await adjustComponentsSb(parseCompRefs(componentIds.join(',')), +1);
  }
  await logActivitySb(actor, directApprove ? 'บันทึกการยืม (โดยแอดมิน)' : 'ขอยืมครุภัณฑ์', (p.assetName || '') + ' → ' + p.borrower);
  return { id, status };
}

async function sApproveBorrow(p, actor) {
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.borrowId).single();
  if (e1 || !b) throw new Error('ไม่พบคำขอยืมรหัส ' + p.borrowId);
  const upd = { status: 'กำลังยืม', approver: p.approverName || actor };
  if (p.sigApprover) upd.sig_approver = p.sigApprover;
  const { error } = await sb.from('borrow').update(upd).eq('id', p.borrowId);
  if (error) throw new Error(error.message);
  await setAssetStatusSb(b.asset_id, 'กำลังยืม', b.borrower);
  await adjustComponentsSb(parseCompRefs(b.component_ids), +1);
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
  const upd = { return_date: p.returnDate || todayStr(), status: 'คืนแล้ว' };
  if (p.conditionPhotoReturn) upd.photo_in = p.conditionPhotoReturn;
  const { error } = await sb.from('borrow').update(upd).eq('id', p.borrowId);
  if (error) throw new Error(error.message);

  // ✅ ตั้งเป็นพร้อมใช้งานเฉพาะเมื่อไม่มีรายการยืมอื่นของครุภัณฑ์นี้ค้างอยู่
  if (!(await hasActiveBorrowSb(b.asset_id))) {
    await setAssetStatusSb(b.asset_id, 'พร้อมใช้งาน', '');
  }
  await adjustComponentsSb(parseCompRefs(b.component_ids), -1);
  await logActivitySb(actor, 'บันทึกการคืน', p.borrowId);
  return { returned: true };
}

async function sUpdateBorrow(p, actor) {
  // ตรวจสอบก่อนว่ามีรายการยืมรหัสนี้อยู่จริงหรือไม่
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.id).single();
  if (e1 || !b) throw new Error('ไม่พบรายการยืมรหัส ' + p.id);

  // อัปเดตเฉพาะฟิลด์ที่ส่งมาเท่านั้น
  const upd = {};
  if (p.borrower !== undefined) upd.borrower = p.borrower;
  if (p.borrowDate !== undefined) upd.borrow_date = p.borrowDate || null;
  if (p.dueDate !== undefined) upd.due_date = p.dueDate || null;
  if (p.returnDate !== undefined) upd.return_date = p.returnDate || null;
  if (p.note !== undefined) upd.note = p.note;

  const { error } = await sb.from('borrow').update(upd).eq('id', p.id);
  if (error) throw new Error('แก้ไขข้อมูลการยืมไม่สำเร็จ: ' + error.message);

  // ถ้าเปลี่ยนชื่อผู้ยืมขณะยังอยู่ในสถานะ "กำลังยืม" ให้อัปเดตผู้ครอบครองในทะเบียนครุภัณฑ์ด้วย
  if (p.borrower !== undefined && b.status === 'กำลังยืม') {
    await setAssetStatusSb(b.asset_id, 'กำลังยืม', p.borrower);
  }

  await logActivitySb(actor, 'แก้ไขข้อมูลการยืม', p.id);
  return { updated: true };
}

// ลบรายการยืม = ย้ายไปถังขยะ (ถ้ายังไม่คืน ต้องคืนสถานะครุภัณฑ์/ส่วนควบก่อน)
async function sDeleteBorrow(p, actor, role) {
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.id).single();
  if (e1 || !b) throw new Error('ไม่พบรายการยืมรหัส ' + p.id);

  const wasActive = (b.status === 'กำลังยืม' || b.status === 'เกินกำหนด');
  await softDeleteSb('borrow', p.id, actor, role);

  if (wasActive) {
    // ✅ คืนสถานะครุภัณฑ์เฉพาะเมื่อไม่มีรายการยืมอื่นค้างอยู่ (หลังลบรายการนี้แล้ว)
    if (!(await hasActiveBorrowSb(b.asset_id))) {
      await setAssetStatusSb(b.asset_id, 'พร้อมใช้งาน', '');
    }
    await adjustComponentsSb(parseCompRefs(b.component_ids), -1);
  }
  await logActivitySb(actor, 'ลบรายการยืม-คืน (ไปถังขยะ)', p.id);
  return { deleted: true };
}

async function sRenewBorrow(p, actor) {
  // ตรวจสอบก่อนว่ามีรายการยืมเดิมอยู่จริง และยังไม่ได้คืน
  const { data: b, error: e1 } = await sb.from('borrow').select('*').eq('id', p.borrowId).single();
  if (e1 || !b) throw new Error('ไม่พบรายการยืมรหัส ' + p.borrowId);
  if (b.status !== 'กำลังยืม') throw new Error('ยืมต่อได้เฉพาะรายการที่ยังไม่คืนเท่านั้น');

  const today = todayStr();

  // ปิดรายการเดิมเป็น "คืนแล้ว" ณ วันนี้
  const { error: e2 } = await sb.from('borrow').update({ status: 'คืนแล้ว', return_date: today }).eq('id', p.borrowId);
  if (e2) throw new Error('ปิดรายการเดิมไม่สำเร็จ: ' + e2.message);

  // เปิดรายการยืมใหม่ให้ผู้ยืมคนเดิม (ครุภัณฑ์ยังอยู่ในสถานะ "กำลังยืม" อยู่แล้ว)
  const newId = genId('BRW');
  const row = {
    id: newId, asset_id: b.asset_id, asset_name: b.asset_name, borrower: b.borrower,
    borrower_line_id: b.borrower_line_id || '', borrow_date: today, due_date: p.dueDate || null,
    status: 'กำลังยืม', approver: actor, note: p.note !== undefined ? p.note : (b.note || ''),
    component_ids: b.component_ids || '', photo_out: b.photo_out || '',
    sig_borrower: b.sig_borrower || '', sig_approver: b.sig_approver || ''
  };
  const { error: e3 } = await sb.from('borrow').insert(row);
  if (e3) throw new Error('เปิดรายการยืมใหม่ไม่สำเร็จ: ' + e3.message);

  await logActivitySb(actor, 'ยืมต่อ (คนเดิม)', b.borrower + ' → ' + b.asset_name);
  return { renewed: true, newId };
}

function markOverdue(borrow) {
  const today = todayStr();
  borrow.forEach(b => {
    const due = String(b['กำหนดคืน'] || '').slice(0, 10);
    if (b['สถานะ'] === 'กำลังยืม' && due && due < today) b['สถานะ'] = 'เกินกำหนด';
  });
}

// ==================== MAINTENANCE ====================
async function sAddMaint(p, actor) {
  const id = genId('MNT');
  const row = {
    id, asset_id: p.assetId, asset_name: p.assetName || '', report_date: p.reportDate || null,
    issue: p.issue, reporter: p.reporter || '', status: 'รอซ่อม', photo: p.photo || '',
    cost: (p.cost !== undefined && p.cost !== '' && p.cost !== null) ? Number(p.cost) : null
  };
  const { error } = await sb.from('maint').insert(row);
  if (error) throw new Error('แจ้งซ่อมไม่สำเร็จ: ' + error.message);
  const assetUpd = { status: 'ซ่อมบำรุง' };
  if (p.tireSize) assetUpd.tire_size = p.tireSize; // เปลี่ยนยางแล้วอัปเดตขนาดยางในทะเบียน
  await sb.from('assets').update(assetUpd).eq('id', p.assetId);
  await logActivitySb(actor, 'แจ้งซ่อมบำรุง', p.assetName);
  return { id };
}

async function sUpdateMaint(p, actor) {
  const upd = {};
  if (p.status !== undefined) upd.status = p.status;
  if (p.finishDate !== undefined) upd.finish_date = p.finishDate || null;
  if (p.cost !== undefined) upd.cost = (p.cost === '' || p.cost === null) ? null : Number(p.cost);
  if (p.responsible !== undefined) upd.responsible = p.responsible;
  if (p.note !== undefined) upd.note = p.note;
  if (p.issue !== undefined) upd.issue = p.issue;
  if (p.reporter !== undefined) upd.reporter = p.reporter;
  if (p.reportDate !== undefined) upd.report_date = p.reportDate || null;
  const { data: m, error: e1 } = await sb.from('maint').select('asset_id').eq('id', p.id).single();
  if (e1 || !m) throw new Error('ไม่พบรายการซ่อมรหัส ' + p.id);
  const { error } = await sb.from('maint').update(upd).eq('id', p.id);
  if (error) throw new Error(error.message);
  if (p.tireSize) await sb.from('assets').update({ tire_size: p.tireSize }).eq('id', m.asset_id);

  // ✅ ปิดงานซ่อม: ตั้งเป็นพร้อมใช้งานเฉพาะเมื่อไม่มีรายการยืมค้างอยู่
  if (p.status === 'ซ่อมเสร็จ') {
    if (!(await hasActiveBorrowSb(m.asset_id))) {
      await setAssetStatusSb(m.asset_id, 'พร้อมใช้งาน');
    }
  } else if (p.status === 'รอซ่อม' || p.status === 'กำลังซ่อม') {
    await setAssetStatusSb(m.asset_id, 'ซ่อมบำรุง');
  }
  await logActivitySb(actor, 'อัปเดตงานซ่อม', p.id);
  return { updated: true };
}

// ลบงานซ่อม = ย้ายไปถังขยะ
async function sDeleteMaint(p, actor, role) {
  const { data: m } = await sb.from('maint').select('asset_id').eq('id', p.id).maybeSingle();
  if (!m) throw new Error('ไม่พบรายการซ่อมรหัส ' + p.id);
  await softDeleteSb('maint', p.id, actor, role);
  // ถ้าไม่มีงานซ่อมที่ยังค้างเหลืออยู่ และไม่มีรายการยืมค้าง ให้คืนสถานะครุภัณฑ์เป็นพร้อมใช้งาน
  const { data: others } = await sb.from('maint').select('id')
    .eq('asset_id', m.asset_id).neq('status', 'ซ่อมเสร็จ').is('deleted_at', null);
  if ((!others || !others.length) && !(await hasActiveBorrowSb(m.asset_id))) {
    await sb.from('assets').update({ status: 'พร้อมใช้งาน' }).eq('id', m.asset_id).eq('status', 'ซ่อมบำรุง');
  }
  await logActivitySb(actor, 'ลบงานซ่อม (ไปถังขยะ)', p.id);
  return { deleted: true };
}

// ==================== COMPONENTS ====================
async function sAddComponent(p, actor) {
  const id = genId('CMP');
  const qty = Math.max(1, parseInt(p.qty, 10) || 1);
  const { error } = await sb.from('components').insert({
    id, parent_id: p.parentId, name: p.name, type: p.type || '', serial: p.serial || '',
    status: 'พร้อมใช้งาน', note: p.note || '', qty, qty_out: 0
  });
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'เพิ่มส่วนควบ', p.name + ' x' + qty);
  return { id };
}

async function sUpdateComponent(p, actor) {
  const upd = {};
  ['name', 'type', 'serial', 'status', 'note'].forEach(k => { if (p[k] !== undefined) upd[k] = p[k]; });
  if (p.qty !== undefined) {
    const qty = Math.max(1, parseInt(p.qty, 10) || 1);
    upd.qty = qty;
    const { data: cur } = await sb.from('components').select('qty_out').eq('id', p.id).single();
    const out = Math.min(qty, (cur && cur.qty_out) || 0);
    upd.qty_out = out;
    if (out >= qty) upd.status = 'กำลังยืม';
    else if (upd.status === undefined) upd.status = 'พร้อมใช้งาน';
  }
  const { error } = await sb.from('components').update(upd).eq('id', p.id);
  if (error) throw new Error(error.message);
  await logActivitySb(actor, 'แก้ไขส่วนควบ', p.id);
  return { updated: true };
}

// ลบส่วนควบ = ย้ายไปถังขยะ
async function sDeleteComponent(id, actor, role) {
  await softDeleteSb('components', id, actor, role);
  await logActivitySb(actor, 'ลบส่วนควบ (ไปถังขยะ)', id);
  return { deleted: true };
}

// ==================== USERS ====================
async function sAddUser(p, actor) {
  const id = genId('OFC');
  let photoUrl = '';
  if (p.photoData) photoUrl = (await gasUploadImageToDrive(p.photoData, 'user-' + id)).url;
  else if (p.photo) photoUrl = p.photo;
  const row = {
    id, line_user_id: p.lineUserId || '', name: p.name, position: p.position || '', unit: p.unit || '',
    role: p.role || 'viewer', rank: p.rank || '', memo_role: p.memoRole || 'ไม่ระบุ (เลือกเองตอนพิมพ์)',
    photo: photoUrl, username: p.username || '', signature: p.signature || ''
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

  // 1) ข้อมูลทั่วไปในตาราง users (บันทึกก่อนเสมอ)
  const upd = {};
  if (p.name !== undefined) upd.name = p.name;
  if (p.position !== undefined) upd.position = p.position;
  if (p.unit !== undefined) upd.unit = p.unit;
  if (p.role !== undefined) upd.role = p.role;
  if (p.rank !== undefined) upd.rank = p.rank;
  if (p.memoRole !== undefined) upd.memo_role = p.memoRole;
  if (p.photoData) upd.photo = (await gasUploadImageToDrive(p.photoData, 'user-' + val)).url;
  else if (p.photo !== undefined) upd.photo = p.photo;
  if (p.signature !== undefined) upd.signature = p.signature;

  const { error } = await sb.from('users').update(upd).eq(col, val);
  if (error) throw new Error('แก้ไขไม่สำเร็จ: ' + error.message);

  // 2) ข้อมูลส่วนบุคคลในตาราง user_private (ต้องมีบัญชีเข้าระบบก่อน)
  const privUpd = {};
  if (p.phone !== undefined) privUpd.phone = p.phone;
  if (p.citizenId !== undefined) privUpd.citizen_id = String(p.citizenId || '').replace(/\D/g, ''); // ⚠️ ควรเข้ารหัสตามระบบเดิม
  if (p.birthDate !== undefined) privUpd.birth_date = p.birthDate || null;
  if (p.bloodType !== undefined) privUpd.blood_type = p.bloodType;

  let personalSaved = false;
  if (Object.keys(privUpd).length) {
    const { data: ur, error: ue } = await sb.from('users')
      .select('auth_user_id').eq(col, val).maybeSingle();
    if (ue) throw new Error('อ่านข้อมูลผู้ใช้ไม่สำเร็จ: ' + ue.message);

    if (ur && ur.auth_user_id) {
      const { error: pe } = await sb.from('user_private').upsert(
        { auth_user_id: ur.auth_user_id, ...privUpd, updated_at: new Date().toISOString() },
        { onConflict: 'auth_user_id' }
      );
      if (pe) throw new Error('บันทึกข้อมูลส่วนบุคคลไม่สำเร็จ: ' + pe.message);
      personalSaved = true;
    }
    // ถ้ายังไม่มีบัญชี ไม่ throw เพื่อให้ข้อมูลทั่วไปยังถูกบันทึก หน้าเว็บควรแจ้งเตือนให้บันทึกซ้ำหลังเปิดบัญชี
  }

  await logActivitySb(actor, 'แก้ไขข้อมูล จนท.', p.name || val);
  return { updated: true, photoUrl: upd.photo, personalSaved };
}

// ลบผู้ใช้ = ย้ายไปถังขยะ
async function sDeleteUser(p, actor, role) {
  let id = p.officerId;
  if (!id) {
    if (!p.identifier) throw new Error('ไม่พบตัวระบุผู้ใช้สำหรับลบ');
    for (const col of ['line_user_id', 'username', 'name']) {
      const { data } = await sb.from('v_users').select('id').eq(col, p.identifier);
      if (data && data.length === 1) { id = data[0].id; break; }
      if (data && data.length > 1) throw new Error('พบรายชื่อซ้ำหลายรายการ ลบอัตโนมัติไม่ได้');
    }
    if (!id) throw new Error('ไม่พบผู้ใช้ที่ต้องการลบ');
  }
  await softDeleteSb('users', id, actor, role);
  await logActivitySb(actor, 'ลบรายชื่อ จนท. (ไปถังขยะ)', id);
  return { deleted: true };
}

// ==================== MEMOS ====================
async function sAddMemo(p, actor) {
  const id = genId('MEMO');
  const row = {
    id, subject: p.subject || 'ไม่ระบุเรื่อง', requester_name: p.requesterName || '', doc_date: p.docDate || '',
    html: p.html || '', borrow_id: p.borrowId || '', status: p.status || 'บันทึกแล้ว', created_by: actor || ''
  };
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

// ลบเอกสารใบเบิก = ย้ายไปถังขยะ
async function sDeleteMemo(id, actor, role) {
  await softDeleteSb('memos', id, actor, role);
  await logActivitySb(actor, 'ลบเอกสารใบเบิก (ไปถังขยะ)', id);
  return { deleted: true };
}

// ==================== SYSTEM SETTINGS ====================
async function sUpdateSystemSettings(p, actor) {
  const updates = {};
  if (p.orgName !== undefined) updates.orgName = String(p.orgName || '').trim();
  if (p.orgPhone !== undefined) updates.orgPhone = String(p.orgPhone || '').trim();
  if (p.docNoPrefix !== undefined) updates.docNoPrefix = String(p.docNoPrefix || '').trim();
  if (p.docNoNext !== undefined) updates.docNoNext = String(p.docNoNext || '').trim();
  if (p.memoAddressee !== undefined) updates.memoAddressee = String(p.memoAddressee || '').trim();
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
  if (p.categoryIcons !== undefined) updates.categoryIcons = String(p.categoryIcons || '');

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

  if (p.oilDocNoPrefix !== undefined) updates.oilDocNoPrefix = String(p.oilDocNoPrefix || '').trim();
  if (p.oilDocNoNext !== undefined) updates.oilDocNoNext = String(p.oilDocNoNext || '').trim();

  for (const key of Object.keys(updates)) {
    const { error } = await sb.from('system_settings').upsert({ key, value: String(updates[key]), updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  await logActivitySb(actor, 'แก้ไขการตั้งค่าระบบ', '');
  return { updated: true, settings: await sGetSystemSettings() };
}

// ==================== AUDIT / MONTHLY CHECK ====================
async function sSaveAuditRecord(p, actor) {
  const year = Number(p.year) || new Date().getFullYear();
  const { data: existing, error: e0 } = await sb.from('audit_records').select('id')
    .eq('asset_id', p.assetId).eq('year', year).maybeSingle();
  if (e0) throw new Error('ตรวจสอบข้อมูลเดิมไม่สำเร็จ: ' + e0.message);

  const payload = {
    result: p.status || 'ยังไม่ตรวจ', inspector: actor || '', note: p.note || '',
    inspected_at: new Date().toISOString(),
    found_status: p.foundStatus || '',
    condition_score: p.conditionScore !== undefined && p.conditionScore !== '' ? Number(p.conditionScore) : null,
    last_used_date: p.lastUsedDate || null, committee_decision: p.committeeDecision || ''
  };

  if (existing) {
    const { error } = await sb.from('audit_records').update(payload).eq('id', existing.id);
    if (error) throw new Error('บันทึกผลตรวจไม่สำเร็จ: ' + error.message);
  } else {
    const { error } = await sb.from('audit_records')
      .insert({ id: genId('AUD'), asset_id: p.assetId, asset_name: p.assetName || '', year, ...payload });
    if (error) throw new Error('บันทึกผลตรวจไม่สำเร็จ: ' + error.message);
  }

  await logActivitySb(actor, 'บันทึกผลตรวจนับยานพาหนะ', p.assetId + ' → ' + (p.status || ''));
  return { saved: true };
}

async function sSaveMonthlyCheck(p, actor) {
  const year = Number(p.year), month = Number(p.month);
  if (!year || !month || !p.officerId) throw new Error('ข้อมูลการตรวจไม่ครบ');
  const { data: existing, error: e0 } = await sb.from('monthly_checks').select('id')
    .eq('year', year).eq('month', month).eq('officer_id', p.officerId).maybeSingle();
  if (e0) throw new Error('ตรวจสอบข้อมูลเดิมไม่สำเร็จ: ' + e0.message);

  const payload = {
    officer_name: p.officerName || '', result: p.result === 'มีปัญหา' ? 'มีปัญหา' : 'ครบ',
    note: p.note || '', holdings_snapshot: p.holdingsSnapshot || '',
    inspector: actor || '', inspected_at: new Date().toISOString()
  };
  if (existing) {
    const { error } = await sb.from('monthly_checks').update(payload).eq('id', existing.id);
    if (error) throw new Error('บันทึกผลตรวจไม่สำเร็จ: ' + error.message);
  } else {
    const { error } = await sb.from('monthly_checks')
      .insert({ id: genId('MCK'), year, month, officer_id: p.officerId, ...payload });
    if (error) throw new Error('บันทึกผลตรวจไม่สำเร็จ: ' + error.message);
  }
  await logActivitySb(actor, 'ตรวจประจำเดือน', (p.officerName || p.officerId) + ' → ' + payload.result);
  return { saved: true, inspectedAt: payload.inspected_at };
}

async function sClearMonthlyCheck(p, actor) {
  const { error } = await sb.from('monthly_checks').delete()
    .eq('year', Number(p.year)).eq('month', Number(p.month)).eq('officer_id', p.officerId);
  if (error) throw new Error('ล้างผลตรวจไม่สำเร็จ: ' + error.message);
  await logActivitySb(actor, 'ล้างผลตรวจประจำเดือน', p.officerName || p.officerId);
  return { cleared: true };
}

async function sChangeRolePassword(p) {
  const { data, error } = await sb.rpc('admin_set_role_password', { p_role: p.role, p_new_password: p.newPassword });
  if (error) throw new Error(error.message);
  return { updated: !!data };
}

// ==================== TRASH: กู้คืน / ลบถาวร ====================
async function restoreSb(table, id, actor, role) {
  const { data, error } = await sb.rpc('restore_item', { p_table: table, p_id: id, p_actor: actor, p_role: role });
  if (error) throw new Error(error.message);
  // กู้ครุภัณฑ์แล้ว ถ้าสถานะเป็น "จำหน่ายแล้ว" ให้ตั้งกลับเป็นพร้อมใช้งาน
  if (table === 'assets') await sb.from('assets').update({ status: 'พร้อมใช้งาน' }).eq('id', id).eq('status', 'จำหน่ายแล้ว');
  await logActivitySb(actor, 'กู้คืนรายการจากถังขยะ', table + ' / ' + id);
  return data;
}

// ลบถาวร + ลบรูปบน Drive (DB ไม่รู้จัก Drive จึงต้องทำใน JS)
async function purgeWithImagesSb(table, id, actor, role) {
  const { data: row } = await sb.from(table).select('*').eq('id', id).maybeSingle();
  const urls = row
    ? ['image_url', 'photo', 'photo_out', 'photo_in', 'signature', 'sig_borrower', 'sig_approver']
        .map(k => row[k]).filter(Boolean)
    : [];
  const { data, error } = await sb.rpc('purge_item', { p_table: table, p_id: id, p_actor: actor, p_role: role });
  if (error) throw new Error(error.message);
  for (const u of urls) await gasDeleteImage(u);
  await logActivitySb(actor, 'ลบถาวรจากถังขยะ', table + ' / ' + id);
  return data;
}

// ==================== IMAGE MAINTENANCE ====================
// ดึงรหัสไฟล์ไดร์ฟจากข้อความ (รองรับ lh3.../d/ID, drive.google.com/file/d/ID, uc?id=ID)
function collectDriveIds(text, set) {
  const re = /(?:\/d\/|[?&]id=)([\w-]{20,})/g;
  let m; text = String(text || '');
  while ((m = re.exec(text))) set.add(m[1]);
}

const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000; // ไม่แตะไฟล์ที่อัปโหลดภายใน 24 ชม.

async function sScanOrphanImages() {
  const refs = new Set();
  // ใช้ "ตารางจริง" ไม่ใช่ view เพราะรายการในถังขยะยังต้องถือว่าอ้างอิงรูปอยู่
  const cols = [
    ['assets', 'image_url'], ['users', 'photo'], ['users', 'signature'],
    ['borrow', 'photo_out'], ['borrow', 'photo_in'],
    ['borrow', 'sig_borrower'], ['borrow', 'sig_approver'], ['maint', 'photo']
  ];
  // ถ้าอ่านตารางไหนไม่สำเร็จ fetchAll จะ throw -> หยุดทั้งหมด ไม่เสี่ยงลบมั่ว
  for (const [t, c] of cols) {
    const rows = await fetchAll(t, 'id,' + c, 'id');
    rows.forEach(r => collectDriveIds(r[c], refs));
  }
  // เอกสารใบเบิก: รูป/ลายเซ็นฝังอยู่ใน HTML (ดึงทีละน้อยเพราะไฟล์ใหญ่)
  for (let from = 0; ; from += 50) {
    const { data, error } = await sb.from('memos').select('id,html').order('id').range(from, from + 49);
    if (error) throw new Error('memos: ' + error.message);
    (data || []).forEach(r => collectDriveIds(r.html, refs));
    if (!data || data.length < 50) break;
  }
  // ตราครุฑ + ค่าตั้งค่าอื่น ๆ
  const { data: st, error: es } = await sb.from('system_settings').select('value');
  if (es) throw new Error('system_settings: ' + es.message);
  (st || []).forEach(r => collectDriveIds(r.value, refs));

  const { files } = await gasCall('listImages', {});
  if (files.length > 20 && refs.size === 0) throw new Error('ไม่พบรูปที่ถูกอ้างอิงเลย ผิดปกติ จึงหยุดเพื่อความปลอดภัย');

  const now = Date.now();
  const orphans = files.filter(f => !refs.has(f.id) && now - f.created > ORPHAN_GRACE_MS);
  return {
    totalFiles: files.length, referenced: refs.size,
    orphanCount: orphans.length,
    orphanBytes: orphans.reduce((s, f) => s + (Number(f.size) || 0), 0),
    ids: orphans.map(f => f.id)
  };
}

async function sTrashOrphanImages(p, actor) {
  const ids = Array.isArray(p.ids) ? p.ids : [];
  let trashed = 0, skipped = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const r = await gasCall('trashFiles', { ids: ids.slice(i, i + 100) });
    trashed += r.trashed; skipped += r.skipped;
  }
  await logActivitySb(actor, 'ล้างไฟล์รูปกำพร้า', 'ลงถังขยะ ' + trashed + ' / ข้าม ' + skipped);
  return { trashed, skipped };
}

// ย้ายรูปเก่า (base64) ขึ้น Drive
async function sMigrateImagesToDrive(actor) {
  const targets = [
    ['assets', 'image_url'], ['users', 'photo'], ['users', 'signature'],
    ['borrow', 'photo_out'], ['borrow', 'photo_in'],
    ['borrow', 'sig_borrower'], ['borrow', 'sig_approver'], ['maint', 'photo']
  ];
  let migrated = 0, failed = 0;
  for (const [table, col] of targets) {
    const { data, error } = await sb.from(table).select('id,' + col).like(col, 'data:image%');
    if (error) { failed++; continue; }
    for (const row of data || []) {
      try {
        const { url } = await gasUploadImageToDrive(row[col], table + '-' + col + '-' + row.id);
        if (!url) throw new Error('no url');
        const { error: e2 } = await sb.from(table).update({ [col]: url }).eq('id', row.id);
        if (e2) throw e2;
        migrated++;
      } catch (e) { failed++; }
    }
  }
  // ตราครุฑ (อยู่ใน system_settings)
  const { data: g } = await sb.from('system_settings').select('value').eq('key', 'garudaLogo').maybeSingle();
  if (g && /^data:image\//i.test(g.value || '')) {
    try {
      const { url } = await gasUploadImageToDrive(g.value, 'garuda');
      await sb.from('system_settings').upsert({ key: 'garudaLogo', value: url, updated_at: new Date().toISOString() });
      migrated++;
    } catch (e) { failed++; }
  }
  await logActivitySb(actor, 'ย้ายรูปเก่าไป Drive', 'สำเร็จ ' + migrated + ' / ล้มเหลว ' + failed);
  return { migrated, failed };
}

async function gasCall(action, payload) {
  const res = await fetch(GAS_UPLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, uploadKey: GAS_UPLOAD_KEY, payload })
  });
  const j = JSON.parse(await res.text());
  if (!j.ok) throw new Error(j.error || 'เซิร์ฟเวอร์รูปภาพผิดพลาด');
  return j.data;
}

async function gasDeleteImage(url) {
  if (!url || !/googleusercontent\.com\/d\//.test(url)) return;
  try {
    await fetch(GAS_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'deleteImage', uploadKey: GAS_UPLOAD_KEY, payload: { url } })
    });
  } catch (e) { /* ลบรูปไม่สำเร็จไม่ควรทำให้งานหลักล้ม */ }
}

// ==================== POST DISPATCHER ====================
const ADMIN_ACTIONS = [
  'addAsset', 'updateAsset', 'deleteAsset', 'borrowAsset', 'returnAsset', 'updateBorrow', 'deleteBorrow', 'renewBorrow',
  'approveBorrowRequest', 'rejectBorrowRequest', 'addMaint', 'updateMaint', 'addUser', 'updateUserRole',
  'deleteUser', 'addComponent', 'updateComponent', 'deleteComponent', 'deleteMemo', 'updateSystemSettings',
  'saveAuditRecord', 'migrateImagesToDrive', 'changeRolePassword', 'saveMonthlyCheck', 'clearMonthlyCheck',
  'scanOrphanImages', 'trashOrphanImages',
  'restoreItem', 'purgeItem' // เพิ่มใหม่: ถังขยะ ทำได้เฉพาะแอดมิน
];
const AUTH_ACTIONS = ['requestBorrow', 'addMemo', 'updateMemo', 'uploadImage', 'deleteMaint'];
// ✅ งานที่ผู้ใช้ทั่วไปทำได้เมื่อมีสิทธิ์ที่ระบุ (ฐานข้อมูลยังเป็นด่านจริง ผ่าน RLS)
const PERM_ACTIONS = {
  saveAuditRecord: 'annual_count', saveMonthlyCheck: 'monthly_check', clearMonthlyCheck: 'monthly_check',
  // แจ้งซ่อม: ใช้สิทธิ์เดียวกับหน้าแจ้งซ่อม (canReportAnyMaint ในหน้าเว็บ)
  addMaint: ['maint', 'annual_count', 'monthly_check']
};
// p เป็นชื่อสิทธิ์ หรือรายการสิทธิ์ (มีสิทธิ์ใดสิทธิ์หนึ่งก็ผ่าน)
function clientHasPerm(p) {
  const w = (typeof window !== 'undefined') ? window.__perms : null;
  if (!w) return false;
  if (w.admin) return true;
  return [].concat(p).some(k => (w.perms || []).indexOf(k) !== -1);
}

async function supaApiPost(action, payload, role, actorName) {
  role = role || 'guest';
  payload = payload || {};
  if (ADMIN_ACTIONS.indexOf(action) !== -1 && role !== 'admin' && !(PERM_ACTIONS[action] && clientHasPerm(PERM_ACTIONS[action]))) throw new Error('ไม่มีสิทธิ์ทำรายการนี้ (ต้องเป็นแอดมิน)');
  if (AUTH_ACTIONS.indexOf(action) !== -1 && role === 'guest') throw new Error('กรุณาเข้าสู่ระบบก่อนทำรายการนี้');
  actorName = actorName || (role === 'admin' ? 'แอดมิน' : (role === 'viewer' ? 'ผู้ดูอย่างเดียว' : 'ไม่ทราบผู้ใช้'));

  switch (action) {
    case 'uploadImage': return await gasUploadImageToDrive(payload.dataUrl, payload.fileName);
    case 'addAsset': return await sAddAsset(payload, actorName);
    case 'updateAsset': return await sUpdateAsset(payload, actorName);
    case 'deleteAsset': return await sDeleteAsset(payload.id, actorName, role);
    case 'borrowAsset': return await sBorrowAsset(payload, actorName, true);
    case 'requestBorrow': return await sBorrowAsset(payload, actorName, false);
    case 'approveBorrowRequest': return await sApproveBorrow(payload, actorName);
    case 'rejectBorrowRequest': return await sRejectBorrow(payload, actorName);
    case 'returnAsset': return await sReturnAsset(payload, actorName);
    case 'updateBorrow': return await sUpdateBorrow(payload, actorName);
    case 'deleteBorrow': return await sDeleteBorrow(payload, actorName, role);
    case 'renewBorrow': return await sRenewBorrow(payload, actorName);
    case 'addMaint': return await sAddMaint(payload, actorName);
    case 'updateMaint': return await sUpdateMaint(payload, actorName);
    case 'deleteMaint': return await sDeleteMaint(payload, actorName, role);
    case 'addComponent': return await sAddComponent(payload, actorName);
    case 'updateComponent': return await sUpdateComponent(payload, actorName);
    case 'deleteComponent': return await sDeleteComponent(payload.id, actorName, role);
    case 'addUser': return await sAddUser(payload, actorName);
    case 'updateUserRole': return await sUpdateUserRole(payload, actorName);
    case 'deleteUser': return await sDeleteUser(payload, actorName, role);
    case 'addMemo': return await sAddMemo(payload, actorName);
    case 'updateMemo': return await sUpdateMemo(payload, actorName);
    case 'deleteMemo': return await sDeleteMemo(payload.id, actorName, role);
    case 'updateSystemSettings': return await sUpdateSystemSettings(payload, actorName);
    case 'saveAuditRecord': return await sSaveAuditRecord(payload, actorName);
    case 'migrateImagesToDrive': return await sMigrateImagesToDrive(actorName);
    case 'changeRolePassword': return await sChangeRolePassword(payload);
    case 'saveMonthlyCheck': return await sSaveMonthlyCheck(payload, actorName);
    case 'clearMonthlyCheck': return await sClearMonthlyCheck(payload, actorName);
    case 'scanOrphanImages': return await sScanOrphanImages();
    case 'trashOrphanImages': return await sTrashOrphanImages(payload, actorName);
    case 'restoreItem': return await restoreSb(payload.sheet, payload.id, actorName, role);
    case 'purgeItem': return await purgeWithImagesSb(payload.sheet, payload.id, actorName, role);
    default: throw new Error('ไม่รู้จัก action: ' + action);
  }
}

// ตัดยศออกจากข้อความ (รองรับทั้งแบบมีและไม่มีช่องว่างหลังยศ)
function stripRank(text){
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  for (const r of [...RANK_OPTIONS].sort((a, b) => b.length - a.length)) {
    if (t.startsWith(r)) { t = t.slice(r.length).trim(); break; }
  }
  return t;
}

// แยกเป็น { first, last } โดยไม่สนยศ ช่องว่าง และตัวพิมพ์
// "จ.ส.ต. ฉัตรชัย  เกตุถาวร" -> { first: 'ฉัตรชัย', last: 'เกตุถาวร' }
function splitPersonName(text){
  const t = stripRank(text);
  const parts = t.split(' ').filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const first = parts.length > 1 ? parts.slice(0, -1).join('') : parts[0];
  return {
    first: first.replace(/\s+/g, '').toLowerCase(),
    last: last.replace(/\s+/g, '').toLowerCase()
  };
}

// เทียบว่าเป็นคนเดียวกันหรือไม่ ถ้าชื่อหรือนามสกุลตรงกันก็ถือว่าตรง
// (เลือก logic นี้ได้: 'and' = ต้องตรงทั้งสองส่วน, 'or' = ตรงส่วนใดส่วนหนึ่ง)
function samePerson(a, b, mode = 'and'){
  const A = splitPersonName(a), B = splitPersonName(b);
  if (!A.first && !A.last) return false;
  if (!B.first && !B.last) return false;
  const firstOk = A.first && B.first && A.first === B.first;
  const lastOk  = A.last  && B.last  && A.last  === B.last;
  return mode === 'or' ? (firstOk || lastOk) : (firstOk && lastOk);
}

// mcHoldingsOf / offHoldings / openOfficerProfile
function holdingsOfPerson(u){
  const full = officerFullName(u);
  const nm = u['ชื่อ-สกุล'];
  return (state.borrow || []).filter(b => {
    const st = effectiveBorrowStatus(b);
    if (st !== 'กำลังยืม' && st !== 'เกินกำหนด') return false;
    return samePerson(b['ผู้ยืม'], full) || samePerson(b['ผู้ยืม'], nm);
  });
}
