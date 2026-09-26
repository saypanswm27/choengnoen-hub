/* ==========================================================================
   master-client.js — ตัวอ่านฐานข้อมูลกลาง (อ่านอย่างเดียว) สำหรับระบบงานทุกระบบ
   ข้อมูลจริงอยู่ใน Firestore ของ CN-Hub (โปรเจกต์ choengnoen-index) แก้ไขได้ที่หน้า master-data.html เท่านั้น

   วิธีใช้ในระบบงาน (วางหลัง firebase-*-compat.js และก่อน firebase-layer.js ของระบบนั้น):
     <script src="https://choengnoen.github.io/choengnoen-hub/master-client.js"></script>

     await CNMaster.ready;                       // รอข้อมูลชุดแรก (สายทาง + เขตพื้นที่ + ราคาประเมินปีงบปัจจุบัน)
     CNMaster.routes()                           // สายทางทั้งหมด (รวมที่โอนแล้ว) — รูปแบบเดียวกับ routes เดิมของระบบอุบัติเหตุ/โจรกรรม
     CNMaster.findRoute('3', 230500)             // สายทางที่ครอบคลุม ทล.3 กม.230+500
     CNMaster.findZone('3', 230500)              // เขตพื้นที่ (สภ./ตำบล/อำเภอ) ของจุดนั้น
     CNMaster.findRightOfWay('3', 230500)        // ความกว้างเขตทาง { left, right, basis, ... } ของจุดนั้น
     CNMaster.findSurface('3', 230500)           // ลักษณะผิวทาง { lanesLt, lanesRt, surface, shoulderLeftWidth, ... }
     CNMaster.clearanceToBoundary('3', 230500)   // ระยะจากขอบไหล่ทางถึงแนวเขตทาง ซ้าย/ขวา (ม.)
     await CNMaster.loadAssets(2568)             // โหลดราคาประเมินปีงบอื่นเพิ่ม (ปีปัจจุบันและปีก่อนโหลดให้อัตโนมัติ)
     CNMaster.assets(2569)                       // รายการราคาประเมินของปีงบ (ไม่ระบุปี = ชุดที่ใช้อยู่ ดู assetsYear)
     CNMaster.assetsYear()                       // ปีงบของราคาที่ใช้อยู่ = ปีล่าสุดที่มีราคา (ปีที่ไม่ได้ปรับราคาใช้ราคาล่าสุดต่อ)
     CNMaster.assetsNotice()                     // "ปีงบนี้ไม่มีการปรับราคา ใช้ราคาจากปีงบ …" (ปีนี้มีราคาเอง คืน null)
     CNMaster.priceOn('mat-002', '2026-03-15')   // ราคาของรายการ ณ วันที่ (ใช้ปีงบของวันนั้น)
     CNMaster.onChange(function (what) { ... })  // เรียกเมื่อเจ้าของแก้ข้อมูลกลาง what = 'routes' | 'zones' | 'assets_2569' ...
     CNMaster.adminRoutes()                      // สายทางในรูปแบบของระบบบริหารหมวด (routeNo, ranges เป็นกิโลเมตร)

   หน่วย กม. ในฐานข้อมูลกลางเก็บเป็น "เมตร" เสมอ (223+650 = 223650)
   ปีงบประมาณเป็น พ.ศ. เริ่ม 1 ต.ค. ของปีก่อนหน้า
   ========================================================================== */
(function () {
  'use strict';
  if (window.CNMaster) return;

  const hubConfig = {
    apiKey: "AIzaSyA_WKBSteeP5EZQ08_K7zOh8J_Wwed4pYY",
    authDomain: "choengnoen-index.firebaseapp.com",
    projectId: "choengnoen-index",
    storageBucket: "choengnoen-index.firebasestorage.app",
    messagingSenderId: "443440738049",
    appId: "1:443440738049:web:77472f2ce7c2994b9b7500"
  };

  const M = {};
  window.CNMaster = M;

  const docs = {};        // docId → ข้อมูลล่าสุด
  const listeners = [];
  const watching = {};    // docId → Promise ของ snapshot แรก

  /* ---------- ตรากรมทางหลวง (ไฟล์กลางไฟล์เดียว เปลี่ยนที่ฮับแล้วทุกระบบเปลี่ยนตาม) ----------
     ระบบงานไม่ต้องเขียนโค้ดเพิ่ม: <img alt="ตรากรมทางหลวง"> หรือ <img data-cn-emblem> จะถูกเปลี่ยนเป็นตรากลางให้อัตโนมัติ
     (รวมรูปที่สร้างทีหลังด้วย innerHTML) · ไอคอนแท็บ ใส่ <link rel="icon" data-cn-emblem> ถ้าต้องการให้ใช้ตรากลางด้วย
     โหลดตรากลางไม่ได้ (ออฟไลน์/ฮับล่ม) = ใช้ไฟล์ logo ของระบบนั้นต่อไปตามเดิม */
  M.EMBLEM_URL = 'https://choengnoen.github.io/choengnoen-hub/assets/doh-emblem.png';
  (function () {
    const SEL = 'img[data-cn-emblem], img[alt="ตรากรมทางหลวง"], link[rel~="icon"][data-cn-emblem]';
    function apply(root) {
      if (!root.querySelectorAll) return;
      const els = root.matches && root.matches(SEL) ? [root] : [];
      root.querySelectorAll(SEL).forEach(function (el) { els.push(el); });
      els.forEach(function (el) {
        if (el.tagName === 'LINK') el.href = M.EMBLEM_URL;
        else if (el.getAttribute('src') !== M.EMBLEM_URL) el.src = M.EMBLEM_URL;
      });
    }
    const probe = new Image();
    probe.onload = function () {
      function start() {
        apply(document);
        new MutationObserver(function (muts) {
          muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) apply(n); }); });
        }).observe(document.documentElement, { childList: true, subtree: true });
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    };
    probe.src = M.EMBLEM_URL;
  })();

  M.fiscalYear = function (date) {
    const d = date ? new Date(date) : new Date();
    if (isNaN(d)) return null;
    return d.getFullYear() + 543 + (d.getMonth() >= 9 ? 1 : 0);
  };

  if (typeof firebase === 'undefined') {
    console.error('master-client.js: ต้องโหลด firebase-app-compat.js และ firebase-firestore-compat.js ก่อน');
    M.ready = Promise.reject(new Error('Firebase SDK not loaded'));
    return;
  }

  // แอป Firebase ตัวที่สอง แยกจากของระบบงานเอง (ไม่ยุ่งกับการล็อกอินของระบบนั้น)
  const app = firebase.apps.find(function (a) { return a.name === 'cn-master'; }) || firebase.initializeApp(hubConfig, 'cn-master');
  const db = app.firestore();
  try {
    db.enablePersistence({ synchronizeTabs: true }).catch(function () { /* ใช้ต่อแบบไม่มีแคชได้ */ });
  } catch (e) { /* เบราว์เซอร์ไม่รองรับ */ }

  function watchDoc(docId) {
    if (watching[docId]) return watching[docId];
    watching[docId] = new Promise(function (resolve) {
      let first = true;
      db.collection('master').doc(docId).onSnapshot(function (snap) {
        docs[docId] = snap.exists ? snap.data() : null;
        // ช่วง กม. เก็บใน Firestore เป็น [{from, to}] (Firestore ไม่รับรายการซ้อน) แปลงกลับเป็น [[เริ่ม, สิ้นสุด]]
        if (docs[docId] && Array.isArray(docs[docId].items)) {
          docs[docId].items = docs[docId].items.map(function (x) {
            if (!x || !Array.isArray(x.kmRanges)) return x;
            return Object.assign({}, x, { kmRanges: x.kmRanges.map(function (p) { return Array.isArray(p) ? p : [p.from, p.to]; }) });
          });
        }
        if (first) { first = false; resolve(docs[docId]); return; }
        notify(docId);
      }, function (err) {
        console.error('CNMaster: อ่าน master/' + docId + ' ไม่สำเร็จ', err);
        if (first) { first = false; resolve(null); }
      });
    });
    return watching[docId];
  }

  function list(docId) { return (docs[docId] && docs[docId].items) || []; }
  function notify(docId) {
    listeners.forEach(function (cb) { try { cb(docId, docs[docId]); } catch (e) { console.error(e); } });
  }

  // ราคาประเมิน: ปีงบที่ไม่ได้ปรับราคาไม่ต้องสร้างใหม่ ระบบใช้ราคาล่าสุดต่อไปเรื่อย ๆ
  // จึงโหลดปีงบปัจจุบัน + ปีก่อน (เคสย้อนหลัง) + ปีงบล่าสุดที่มีราคา (อาจย้อนไปหลายปี)
  function watchBackTo(y) { // ถอยทีละปีจนเจอปีที่มีราคา
    if (y < 2560) return null;
    return watchDoc('assets_' + y).then(function () { return list('assets_' + y).length ? null : watchBackTo(y - 1); });
  }
  function watchAssetYears(fy) {
    return Promise.all([watchDoc('assets_' + fy), watchDoc('assets_' + (fy - 1))]).then(function () {
      if (!list('assets_' + fy).length && !list('assets_' + (fy - 1)).length) return watchBackTo(fy - 2);
    });
  }
  let watchedFy = M.fiscalYear();
  M.ready = Promise.all([watchDoc('routes'), watchDoc('zones'), watchDoc('rightofway'), watchDoc('surface'), watchAssetYears(watchedFy)]).then(function () { return M; });
  // เปิดหน้าค้างข้าม 1 ต.ค. → เริ่มอ่านราคาปีงบใหม่ แล้วแจ้งระบบงานให้ใช้ราคาชุดใหม่ (ไม่ต้องรีเฟรช)
  setInterval(function () {
    const fy = M.fiscalYear();
    if (fy === watchedFy) return;
    watchedFy = fy;
    watchAssetYears(fy).then(function () { notify('assets_' + fy); });
  }, 10 * 60 * 1000);
  M.onChange = function (cb) { listeners.push(cb); };
  M.version = function (docId) { return docs[docId] ? docs[docId].version : 0; };
  M.updatedAt = function (docId) { return docs[docId] ? (docs[docId].updatedAt || '') : ''; };
  // ลิงก์หน้าแก้ไขข้อมูลกลาง (ใช้ทำปุ่ม "แก้ไขที่ฐานข้อมูลกลาง" ในระบบงาน)
  M.EDIT_URL = 'https://choengnoen.github.io/choengnoen-hub/master-data.html';
  // ลิงก์ไปแท็บที่ต้องการ: 'routes' | 'zones' | 'rightofway' | 'surface' | 'assets'
  M.editUrl = function (tab) { return M.EDIT_URL + (tab ? '#' + tab : ''); };

  /* ---------- สายทาง ---------- */
  M.routes = function () { return list('routes'); };
  M.activeRoutes = function () { return list('routes').filter(function (r) { return r.status !== 'transferred'; }); };
  M.findRoute = function (highway, km) {
    const hw = String(highway).trim();
    const cand = list('routes').filter(function (r) { return String(r.highway) === hw; });
    if (km == null || km === '') return cand[0] || null;
    return cand.find(function (r) { return (r.kmRanges || []).some(function (p) { return km >= p[0] && km <= p[1]; }); }) || null;
  };
  // รูปแบบของระบบบริหารหมวด (choengnoen2-statistics.html: routeFromApi)
  M.adminRoutes = function () {
    return M.activeRoutes().map(function (r, i) {
      return {
        id: r.id, routeNo: r.highway, controlNo: r.controlNo, section: r.section,
        ranges: (r.kmRanges || []).map(function (p) { return [p[0] / 1000, p[1] / 1000]; }),
        distActual: r.distanceActual || 0, dist2Lane: r.distance2Lane || 0,
        asphalt: r.asphalt || 0, concrete: r.concrete || 0, workQty: r.workQty || 0
      };
    });
  };

  /* ---------- เขตพื้นที่ ---------- */
  M.zones = function () { return list('zones'); };
  M.findZone = function (highway, km, side) {
    const hw = String(highway).trim();
    const hits = list('zones').filter(function (z) { return String(z.highway) === hw && km >= z.kmStart && km <= z.kmEnd; });
    if (side) {
      const s = hits.find(function (z) { return z.side === side; });
      if (s) return s;
    }
    return hits[0] || null;
  };

  /* ---------- บัญชีเขตทาง (ความกว้างจากศูนย์กลางทาง ซ้าย/ขวา เป็นเมตร) ---------- */
  M.rightOfWay = function (highway) {
    const all = list('rightofway');
    return highway == null ? all : all.filter(function (x) { return String(x.highway) === String(highway).trim(); });
  };
  // ช่วงเขตทางที่ครอบคลุมจุด กม. (เมตร) — คืนค่า null ถ้าไม่มีในบัญชี
  // ถ้าจุดอยู่ตรงรอยต่อ 2 ช่วง จะคืนช่วงที่ "เริ่ม" ที่จุดนั้น
  M.findRightOfWay = function (highway, km) {
    const hits = M.rightOfWay(highway).filter(function (x) { return km >= x.kmStart && km <= x.kmEnd && x.kmStart < x.kmEnd; });
    hits.sort(function (a, b) { return b.kmStart - a.kmStart; });
    return hits[0] || null;
  };

  /* ---------- ผิวทาง (แยกแถวซ้ายทาง Lt / ขวาทาง Rt, lanes = ช่องจราจรต่อทิศทาง) ---------- */
  M.surface = function (highway) {
    const all = list('surface');
    return highway == null ? all : all.filter(function (x) { return String(x.highway) === String(highway).trim(); });
  };
  // ลักษณะทาง ณ จุด กม. → { lanesLt, lanesRt, lanesTotal, laneWidth, surface: 'ac'|'conc', shoulderLeftWidth, shoulderRightWidth,
  //                         pavementWidth (ผิวจราจรรวม ม.), rows } หรือ null
  M.findSurface = function (highway, km) {
    let rows = M.surface(highway).filter(function (x) { return km >= x.kmStart && km < x.kmEnd; });
    if (!rows.length) rows = M.surface(highway).filter(function (x) { return km === x.kmEnd; }); // จุดปลายสายทาง
    if (!rows.length) return null;
    const lt = rows.find(function (x) { return x.side === 'Lt'; }) || rows[0];
    const rt = rows.find(function (x) { return x.side === 'Rt'; }) || rows[0];
    const w = lt.laneWidth || 3.5;
    return {
      lanesLt: lt.lanes, lanesRt: rt.lanes, lanesTotal: lt.lanes + rt.lanes, laneWidth: w,
      surface: lt.surface, shoulderLeftWidth: lt.shoulderLeftWidth, shoulderRightWidth: rt.shoulderRightWidth,
      pavementWidth: (lt.lanes + rt.lanes) * w, rows: rows
    };
  };
  // ระยะจากขอบไหล่ทางถึงแนวเขตทาง (ม.) ณ จุด กม. — ใช้ประกอบงานขออนุญาต/ชี้แนวเขต/รุกล้ำ
  // ประมาณจากศูนย์กลางทาง: เขตทางฝั่งนั้น − ครึ่งหนึ่งของผิวจราจร − ไหล่ทางฝั่งนั้น
  M.clearanceToBoundary = function (highway, km) {
    const row = M.findRightOfWay(highway, km), s = M.findSurface(highway, km);
    if (!row || !s) return null;
    const half = s.pavementWidth / 2;
    return {
      left: row.left == null ? null : Math.round((row.left - half - (s.shoulderLeftWidth || 0)) * 100) / 100,
      right: row.right == null ? null : Math.round((row.right - half - (s.shoulderRightWidth || 0)) * 100) / 100,
      rightOfWay: row, surface: s
    };
  };

  /* ---------- ราคาประเมินทรัพย์สิน (แยกปีงบ) ---------- */
  M.loadAssets = function (fy) { return watchDoc('assets_' + fy).then(function () { return list('assets_' + fy); }); };
  // ไม่ระบุปี = ราคาชุดที่ใช้อยู่ (ดู assetsYear)
  M.assets = function (fy) { return list('assets_' + (fy || M.assetsYear())); };
  M.fiscalYearsLoaded = function () {
    return Object.keys(docs).filter(function (k) { return /^assets_\d{4}$/.test(k) && docs[k]; })
      .map(function (k) { return Number(k.slice(7)); }).sort(function (a, b) { return a - b; });
  };
  // ปีงบของราคาที่ใช้อยู่จริง: ปีงบล่าสุด (≤ ปีปัจจุบัน) ที่มีราคา — ปีที่ไม่ได้ปรับราคาใช้ราคาล่าสุดต่อ
  M.assetsYear = function () {
    const fy = M.fiscalYear();
    const years = M.fiscalYearsLoaded().filter(function (y) { return y <= fy && list('assets_' + y).length; });
    return years.length ? years[years.length - 1] : fy;
  };
  // ข้อความบอกว่าใช้ราคาจากปีงบไหน เมื่อปีนี้ไม่ได้ปรับราคา (ปีนี้มีราคาเอง/ไม่มีราคาเลย คืน null) — ระบบงานนำไปแสดงได้
  M.assetsNotice = function () {
    const fy = M.fiscalYear(), used = M.assetsYear();
    if (used === fy || !list('assets_' + used).length) return null;
    return 'ปีงบ ' + fy + ' ไม่มีการปรับราคาประเมิน ใช้ราคาล่าสุดจากปีงบ ' + used;
  };
  // ราคาของรายการ ณ วันที่ — ถ้าปีงบนั้นยังไม่มีราคา (หรือยังไม่ได้โหลด) ใช้ปีงบล่าสุดก่อนหน้าที่มี
  M.priceOn = function (key, date) { return M.priceInYear(key, M.fiscalYear(date) || M.fiscalYear()); };
  // ราคาของรายการในปีงบ (พ.ศ.) — ต้อง loadAssets(ปีนั้น) ไว้ก่อน ไม่งั้นใช้ปีก่อนหน้าที่โหลดแล้ว / ไม่มีเลยคืน null
  M.priceInYear = function (key, fy) {
    const years = M.fiscalYearsLoaded().filter(function (y) { return y <= fy; }).reverse();
    for (let i = 0; i < years.length; i++) {
      const a = list('assets_' + years[i]).find(function (x) { return x.key === key; });
      if (a) return { price: a.price, unit: a.unit, name: a.name, fiscalYear: years[i] };
    }
    return null;
  };
})();
