/* ==========================================================================
   firebase-layer.js — ชั้นเชื่อมต่อ Firebase (Authentication + Firestore)
   ศูนย์ปฏิบัติงานเชิงเนิน (CN-Hub) — เว็บรวมลิงก์ระบบงานต้นแบบ

   ต่างจากระบบงานอุบัติเหตุ/โจรกรรม: เว็บนี้มีผู้ล็อกอินได้แค่คนเดียว (เจ้าของเว็บ)
   จึงไม่มีคอลเลกชัน team / ไม่มีการเพิ่มสมาชิก ใช้บัญชี Auth บัญชีเดียวคงที่

   โครงสร้างข้อมูล:
     - sites_public  : การ์ดระบบที่ทีมงานเห็นได้เลยโดยไม่ต้องล็อกอิน (อ่านได้ทุกคน, เขียนได้เฉพาะเจ้าของ)
     - sites_private : การ์ดงานส่วนตัว (อ่าน/เขียนได้เฉพาะเจ้าของที่ล็อกอินแล้วเท่านั้น)
     - config/bootstrap : { uid, at } ระบุว่าใครคือเจ้าของเว็บ ตั้งได้ครั้งเดียว (ดู firestore.rules)

   หมายเหตุ: ค่า firebaseConfig ด้านล่างเป็นค่าสาธารณะโดยออกแบบ (ไม่ใช่รหัสลับ)
   ความปลอดภัยจริงอยู่ที่ firestore.rules
   ========================================================================== */
(function () {
  'use strict';

  const firebaseConfig = {
    apiKey: "AIzaSyA_WKBSteeP5EZQ08_K7zOh8J_Wwed4pYY",
    authDomain: "choengnoen-index.firebaseapp.com",
    projectId: "choengnoen-index",
    storageBucket: "choengnoen-index.firebasestorage.app",
    messagingSenderId: "443440738049",
    appId: "1:443440738049:web:77472f2ce7c2994b9b7500"
  };

  // ล็อกอินได้แค่เจ้าของเว็บคนเดียว ใช้ ID ที่ตั้งเองแปลงเป็นอีเมลสังเคราะห์ (โดเมน .invalid ไม่มีอยู่จริง ไม่มีการส่งอีเมลใดๆ)
  function idToEmail(id) {
    const clean = String(id || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    return clean + '@index.invalid';
  }

  const FBL = {};
  window.FBL = FBL;
  FBL.configured = !/^YOUR_/.test(String(firebaseConfig.apiKey || '')) && !/^YOUR_/.test(String(firebaseConfig.projectId || ''));
  if (!FBL.configured) return; // หน้าเว็บจะแสดงข้อความ "ยังไม่ได้ตั้งค่า" แทน ไม่ทำให้พังทั้งหน้า

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  try {
    db.enablePersistence({ synchronizeTabs: true }).catch(function (e) {
      console.warn('Firestore offline cache unavailable:', e && e.code);
    });
  } catch (e) { /* เบราว์เซอร์ที่ไม่รองรับ — ทำงานต่อแบบไม่มีแคช */ }

  FBL.isOwner = false; // true เมื่อล็อกอินสำเร็จ

  /* ---------- ข้อความผิดพลาดภาษาไทย ---------- */
  function thErr(e) {
    const code = (e && e.code) || '';
    const map = {
      'auth/invalid-credential': 'รหัสผ่านไม่ถูกต้อง',
      'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
      'auth/invalid-login-credentials': 'รหัสผ่านไม่ถูกต้อง',
      'auth/user-not-found': 'ยังไม่ได้ตั้งรหัสผ่านเจ้าของ',
      'auth/too-many-requests': 'ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
      'auth/network-request-failed': 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่',
      'auth/weak-password': 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร',
      'auth/email-already-in-use': 'มีการตั้งรหัสผ่านเจ้าของไว้แล้ว',
      'auth/invalid-email': 'ID ต้องเป็นตัวอักษร/ตัวเลขภาษาอังกฤษเท่านั้น',
      'auth/unauthorized-domain': 'โดเมนนี้ยังไม่ได้รับอนุญาตใน Firebase (Authentication → Settings → Authorized domains)',
      'permission-denied': 'ไม่มีสิทธิ์ทำรายการนี้ (ตรวจสอบว่าวางกฎ firestore.rules แล้ว และล็อกอินด้วยบัญชีเจ้าของ)',
      'unavailable': 'เชื่อมต่อฐานข้อมูลไม่ได้ในขณะนี้ กรุณาลองใหม่'
    };
    return map[code] || ((e && e.message) ? e.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ');
  }
  FBL.errorText = thErr;

  function nowIso() { return new Date().toISOString(); }
  function clean(o) {
    const out = {};
    Object.keys(o).forEach(function (k) {
      let v = o[k];
      if (v === undefined) return;
      if (typeof v === 'number' && !isFinite(v)) v = null;
      out[k] = v;
    });
    return out;
  }

  /* ---------- เจ้าของเว็บ / ล็อกอิน ---------- */
  FBL.hasOwner = async function () {
    const d = await db.collection('config').doc('bootstrap').get();
    return d.exists;
  };

  // ตั้ง ID + รหัสผ่านเจ้าของครั้งแรก — ใช้ได้แค่ตอนยังไม่มีเอกสาร config/bootstrap (ดู firestore.rules)
  FBL.bootstrapOwner = async function (id, password) {
    try {
      const cred = await auth.createUserWithEmailAndPassword(idToEmail(id), password);
      const uid = cred.user.uid;
      try {
        await db.collection('config').doc('bootstrap').set({ uid: uid, ownerId: id, at: nowIso() });
      } catch (e) {
        try { await cred.user.delete(); } catch (_) { /* ล้างบัญชีที่ค้าง */ }
        throw e;
      }
      FBL.isOwner = true;
    } catch (e) { throw new Error(thErr(e)); }
  };

  FBL.login = async function (id, password) {
    try {
      await auth.signInWithEmailAndPassword(idToEmail(id), password);
    } catch (e) { throw new Error(thErr(e)); }
  };

  FBL.logout = async function () {
    await auth.signOut();
    FBL.stopAll();
    FBL.isOwner = false;
  };

  // ต้องเรียกครั้งเดียวตอนเริ่มระบบ — cb(isOwner)
  FBL.onAuth = function (cb) {
    auth.onAuthStateChanged(async function (u) {
      if (!u) { FBL.isOwner = false; cb(false); return; }
      try {
        const d = await db.collection('config').doc('bootstrap').get();
        FBL.isOwner = d.exists && d.data().uid === u.uid;
        if (!FBL.isOwner) await auth.signOut();
        cb(FBL.isOwner);
      } catch (e) {
        FBL.isOwner = false;
        cb(false, thErr(e));
      }
    });
  };

  /* ---------- อ่านการ์ดระบบแบบ realtime ---------- */
  const subs = {};
  FBL.watch = function (col, onChange) {
    if (subs[col]) { subs[col].onChange = onChange || subs[col].onChange; return subs[col].first; }
    const s = subs[col] = { docs: [], firstDone: false, onChange: onChange };
    s.first = new Promise(function (resolve) {
      s.unsub = db.collection(col).onSnapshot(function (snap) {
        s.docs = snap.docs.map(function (d) { return Object.assign({}, d.data(), { __id: d.id }); });
        s.docs.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
        if (!s.firstDone) { s.firstDone = true; resolve(s.docs); }
        else if (s.onChange) { try { s.onChange(col, s.docs); } catch (e) { console.error(e); } }
      }, function (err) {
        console.error('watch ' + col + ' failed', err);
        if (FBL.onError) FBL.onError(thErr(err));
        if (!s.firstDone) { s.firstDone = true; resolve([]); }
      });
    });
    return s.first;
  };
  FBL.onError = null;
  FBL.docs = function (col) { return subs[col] ? subs[col].docs : []; };
  FBL.stop = function (col) {
    if (subs[col]) { subs[col].unsub(); delete subs[col]; }
  };
  FBL.stopAll = function () {
    Object.keys(subs).forEach(function (k) { if (subs[k].unsub) subs[k].unsub(); delete subs[k]; });
  };

  /* ---------- เพิ่ม/แก้/ลบการ์ดระบบ (เจ้าของเท่านั้น — บังคับที่ firestore.rules) ---------- */
  FBL.saveSite = async function (col, site) {
    const isNew = !site.__id;
    const data = clean({
      name: site.name, desc: site.desc || '', url: site.url,
      firebaseUrl: site.firebaseUrl || '', githubUrl: site.githubUrl || '', icon: site.icon || '',
      rowBreakAfter: !!site.rowBreakAfter,
      order: site.order != null ? site.order : Date.now(),
      updatedAt: nowIso()
    });
    if (isNew) {
      await db.collection(col).add(data);
    } else {
      await db.collection(col).doc(site.__id).set(data, { merge: true });
    }
  };

  FBL.deleteSite = async function (col, id) {
    await db.collection(col).doc(id).delete();
  };
})();
