/**
 * 06_Admin.gs
 * 運営者専用の編集ページ。
 *
 * GitHub Pages は静的配信なので、公開サイト側に編集画面を置くと
 * スプレッドシートを書き換えるための鍵をブラウザに埋め込むことになる。
 * そのため編集画面は GAS のウェブアプリとして動かし、
 * 鍵はサーバー側に置いたままにする。
 *
 * 【公開のしかた】
 * GASエディタ右上「デプロイ」→「新しいデプロイ」→ 種類は「ウェブアプリ」
 *   次のユーザーとして実行 : 自分
 *   アクセスできるユーザー : 自分のみ
 * 発行されたURLをブックマークしておけば、スマホからでも開ける。
 *
 * 【編集できる項目】
 * 手で決める必要があるものだけを置いてある。
 * 価格や単価は自動取得なので、ここでは触れない。
 */

const ADMIN = {
  // 商品マスタに無ければ自動で作る列
  EXTRA_COLUMNS: ['体験メモ'],

  // 一覧に出す件数の上限
  MAX_ROWS: 300
};

// ============================================================
// ウェブアプリの入口
// ============================================================

function doGet() {
  return HtmlService.createHtmlOutput(ADMIN_HTML)
    .setTitle('プロテイン図鑑 管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============================================================
// 画面から呼ばれる処理
// ============================================================

/**
 * 商品マスタに、管理画面で使う列が無ければ足す。
 * 既にあれば何もしない。
 */
function adminEnsureColumns() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.MASTER_SHEET_NAME);

  if (!sheet) {
    throw new Error('シートが見つかりません: ' + CONFIG.MASTER_SHEET_NAME);
  }

  const lastCol = sheet.getLastColumn();
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const added = [];

  ADMIN.EXTRA_COLUMNS.forEach(function (name) {
    if (header.indexOf(name) === -1) {
      const col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue(name).setFontWeight('bold');
      sheet.setColumnWidth(col, 320);
      added.push(name);
    }
  });

  return added;
}

/**
 * 一覧に必要なデータを返す。
 * 価格は最新の1件だけを添える（履歴は管理画面では扱わない）。
 */
function adminLoadProducts() {
  adminEnsureColumns();

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(CONFIG.MASTER_SHEET_NAME);
  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return { products: [], updatedAt: '' };
  }

  const col = adminColumnMap_(values[0]);
  const latest = adminLatestPrices_();
  const products = [];

  for (let i = 1; i < values.length && products.length < ADMIN.MAX_ROWS; i++) {
    const row = values[i];
    const productId = String(row[col['商品ID']] || '').trim();

    if (!productId) {
      continue;
    }

    const price = latest[productId] || null;

    products.push({
      row: i + 1,
      productId: productId,
      name: [row[col['ブランド']], row[col['シリーズ']], row[col['味']]]
        .map(function (v) { return String(v || '').trim(); })
        .filter(Boolean).join(' '),
      maker: String(row[col['メーカー']] || '').trim(),
      form: String(row[col['形態']] || '').trim(),
      capacity: row[col['容量g']] || '',
      status: String(row[col['ステータス']] || '').trim(),
      imageUrl: String(row[col['画像URL']] || '').trim(),
      tags: String(row[col['タグ']] || '').trim(),
      note: String(row[col['備考']] || '').trim(),
      experience: col['体験メモ'] !== undefined ? String(row[col['体験メモ']] || '').trim() : '',
      unitPrice: price ? price.unit : '',
      price: price ? price.price : '',
      fetchedAt: price ? price.at : ''
    });
  }

  return {
    products: products,
    updatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日 HH:mm')
  };
}

/**
 * 1商品ぶんの編集内容を保存する。
 * 画面から送られてこなかった項目は触らない。
 */
function adminSaveProduct(payload) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.MASTER_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  const col = adminColumnMap_(values[0]);

  const targetId = String(payload.productId || '').trim();
  let targetRow = -1;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['商品ID']] || '').trim() === targetId) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error('商品が見つかりません: ' + targetId);
  }

  const fields = [
    ['ステータス', 'status'],
    ['画像URL', 'imageUrl'],
    ['タグ', 'tags'],
    ['備考', 'note'],
    ['体験メモ', 'experience']
  ];

  fields.forEach(function (pair) {
    const columnName = pair[0];
    const key = pair[1];

    if (col[columnName] === undefined) return;
    if (payload[key] === undefined) return;

    sheet.getRange(targetRow, col[columnName] + 1).setValue(String(payload[key]));
  });

  return '保存しました: ' + targetId;
}

/**
 * 管理画面からページを作り直す。
 * 04_Build.gs が入っていれば呼ぶ。
 */
function adminRebuild() {
  if (typeof buildAllPages !== 'function') {
    throw new Error('ページ生成の処理（04_Build.gs）がまだ入っていません。');
  }
  return buildAllPages();
}

// ============================================================
// 補助
// ============================================================

/** ヘッダー名から列番号（0始まり）を引く表を作る */
function adminColumnMap_(headerRow) {
  const map = {};

  headerRow.forEach(function (name, index) {
    const key = String(name).trim();
    if (key && map[key] === undefined) {
      map[key] = index;
    }
  });

  const required = ['商品ID', 'ブランド', 'シリーズ', '味', '形態', 'ステータス'];

  required.forEach(function (name) {
    if (map[name] === undefined) {
      throw new Error('商品マスタに列が見つかりません: ' + name);
    }
  });

  return map;
}

/** 価格ログから、商品ごとの最新の1件を取り出す */
function adminLatestPrices_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PRICE_LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return {};
  }

  const values = sheet.getDataRange().getValues();
  const col = {};

  values[0].forEach(function (name, index) {
    col[String(name).trim()] = index;
  });

  const result = {};

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const productId = String(row[col['商品ID']] || '').trim();

    if (!productId) continue;

    const at = row[col['取得日時']];
    const prev = result[productId];

    if (prev && prev.raw instanceof Date && at instanceof Date && at <= prev.raw) {
      continue;
    }

    const isRtd = String(row[col['形態']] || '') === 'RTD';
    const unit = isRtd ? row[col['1本あたり']] : row[col['20gあたり']];

    result[productId] = {
      raw: at,
      at: at instanceof Date ? Utilities.formatDate(at, 'Asia/Tokyo', 'M/d') : '',
      price: row[col['価格']] || '',
      unit: unit === '' || unit === undefined ? '' : unit
    };
  }

  return result;
}

// ============================================================
// 画面
// ============================================================

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<style>
:root{--paper:#F7F6F2;--ink:#131518;--sub:#8A8F94;--hair:#E2E0D9;--stone:#EDEBE4;--whey:#DCE64B;--whey-d:#93A00E}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;font-size:13px;line-height:1.7;padding:0 0 60px}
.wrap{max-width:760px;margin:0 auto;padding:0 16px}
header{display:flex;align-items:flex-end;justify-content:space-between;padding:20px 0 12px;border-bottom:2px solid var(--ink);margin-bottom:14px}
h1{font-size:17px;font-weight:800;letter-spacing:-.01em}
h1 small{display:block;font-size:10px;color:var(--sub);font-weight:400;margin-top:4px}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
input[type=search],select,input[type=text],textarea{font:inherit;color:inherit;background:#fff;border:1px solid var(--hair);border-radius:2px;padding:7px 9px;width:100%}
textarea{resize:vertical;min-height:64px;line-height:1.75}
.bar input[type=search]{flex:1;min-width:180px}
.bar select{width:auto}
button{font:inherit;font-weight:700;background:var(--ink);color:#fff;border:0;border-radius:2px;padding:8px 14px;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--hair);font-weight:500}
button.acc{background:var(--whey);color:var(--ink)}
.item{border-bottom:1px solid var(--hair);padding:14px 0}
.head{display:grid;grid-template-columns:52px 1fr auto;gap:12px;align-items:center;cursor:pointer}
.thumb{width:52px;height:52px;background:#fff;border:1px solid var(--hair);display:flex;align-items:center;justify-content:center;overflow:hidden}
.thumb img{max-width:100%;max-height:100%;object-fit:contain}
.thumb .no{font-size:9px;color:var(--sub);text-align:center;line-height:1.3}
.nm{font-weight:700;font-size:13.5px;line-height:1.45}
.mt{font-size:10.5px;color:var(--sub);margin-top:2px}
.rt{text-align:right;white-space:nowrap}
.rt .u{font-weight:800;font-size:16px;letter-spacing:-.02em}
.rt .us{font-size:10px;color:var(--sub);margin-left:2px}
.pill{display:inline-block;font-size:10px;padding:1px 7px;border-radius:2px;background:var(--stone);color:#3A3F45}
.pill.on{background:var(--whey);color:var(--ink);font-weight:700}
.pill.off{background:#E6E3DC;color:var(--sub)}
.body{display:none;padding:14px 0 4px}
.item.open .body{display:block}
.f{margin-bottom:11px}
.f label{display:block;font-size:10.5px;color:var(--sub);margin-bottom:4px}
.f .hint{font-size:10px;color:var(--sub);margin-top:4px}
.acts{display:flex;gap:8px;align-items:center;margin-top:6px}
.msg{font-size:11px;color:var(--whey-d);font-weight:700}
.msg.err{color:#B3261E}
.loading{padding:50px 0;text-align:center;color:var(--sub);font-size:12px}
.count{font-size:10.5px;color:var(--sub)}
.top{position:sticky;top:0;background:var(--paper);padding-top:2px;z-index:2}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>プロテイン図鑑 管理<small>手で決める項目だけを編集します</small></h1>
    <div class="count" id="stamp"></div>
  </header>

  <div class="top">
    <div class="bar">
      <input type="search" id="q" placeholder="商品名・IDで絞り込む">
      <select id="filter">
        <option value="">すべて</option>
        <option value="公開">公開</option>
        <option value="準備中">準備中</option>
        <option value="停止">停止</option>
        <option value="noimg">画像なし</option>
        <option value="noexp">体験メモなし</option>
      </select>
      <button class="ghost" id="reload">再読込</button>
    </div>
    <div class="count" id="count"></div>
  </div>

  <div id="list"><div class="loading">読み込んでいます…</div></div>
</div>

<script>
let ALL = [];

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function thumb(p){
  if(!p.imageUrl) return '<div class="thumb"><span class="no">画像<br>なし</span></div>';
  const u = p.imageUrl.indexOf('image.rakuten.co.jp')>=0
    ? p.imageUrl.replace(/\\?_ex=\\d+x\\d+$/,'')+'?_ex=200x200' : p.imageUrl;
  return '<div class="thumb"><img src="'+esc(u)+'" alt=""></div>';
}

function statusPill(s){
  const cls = s==='公開' ? 'on' : (s==='停止' ? 'off' : '');
  return '<span class="pill '+cls+'">'+esc(s||'未設定')+'</span>';
}

function render(){
  const q = document.getElementById('q').value.trim().toLowerCase();
  const f = document.getElementById('filter').value;

  const rows = ALL.filter(function(p){
    if(q && (p.name+' '+p.productId+' '+p.maker).toLowerCase().indexOf(q)<0) return false;
    if(f==='noimg') return !p.imageUrl;
    if(f==='noexp') return !p.experience;
    if(f) return p.status===f;
    return true;
  });

  document.getElementById('count').textContent = rows.length+' 件 / 全 '+ALL.length+' 件';

  document.getElementById('list').innerHTML = rows.map(function(p){
    const unit = p.unitPrice==='' ? '<span class="us">価格なし</span>'
      : '<span class="u">'+esc(p.unitPrice)+'</span><span class="us">'+(p.form==='RTD'?'円/本':'円/杯')+'</span>';
    return ''+
    '<div class="item" data-id="'+esc(p.productId)+'">'+
      '<div class="head" onclick="toggle(this)">'+
        thumb(p)+
        '<div><div class="nm">'+esc(p.name||p.productId)+'</div>'+
        '<div class="mt">'+statusPill(p.status)+' '+esc(p.form)+' '+esc(p.capacity)+' ／ '+esc(p.productId)+
        (p.experience?' ／ 体験メモあり':'')+'</div></div>'+
        '<div class="rt">'+unit+'</div>'+
      '</div>'+
      '<div class="body">'+
        '<div class="f"><label>ステータス</label>'+
          '<select data-k="status">'+
            ['公開','準備中','停止'].map(function(s){
              return '<option'+(p.status===s?' selected':'')+'>'+s+'</option>';
            }).join('')+
          '</select></div>'+
        '<div class="f"><label>画像URL</label>'+
          '<input type="text" data-k="imageUrl" value="'+esc(p.imageUrl)+'" placeholder="楽天の画像URL">'+
          '<div class="hint">「画像選定」シートから、販促文字の乗っていないものを選んで貼る</div></div>'+
        '<div class="f"><label>体験メモ</label>'+
          '<textarea data-k="experience" placeholder="実際に使った商品にだけ書く。飲んでいない商品は空のままにする">'+esc(p.experience)+'</textarea>'+
          '<div class="hint">事実・体験・意見のどれかに収める。効果の断定は書かない</div></div>'+
        '<div class="f"><label>タグ</label>'+
          '<input type="text" data-k="tags" value="'+esc(p.tags)+'"></div>'+
        '<div class="f"><label>備考</label>'+
          '<input type="text" data-k="note" value="'+esc(p.note)+'"></div>'+
        '<div class="acts"><button onclick="save(this)">保存</button>'+
          '<span class="msg"></span></div>'+
      '</div>'+
    '</div>';
  }).join('') || '<div class="loading">該当する商品がありません</div>';
}

function toggle(el){ el.parentNode.classList.toggle('open'); }

function save(btn){
  const item = btn.closest('.item');
  const msg = item.querySelector('.msg');
  const payload = { productId: item.dataset.id };

  item.querySelectorAll('[data-k]').forEach(function(el){
    payload[el.dataset.k] = el.value;
  });

  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = '保存中…';

  google.script.run
    .withSuccessHandler(function(){
      btn.disabled = false;
      msg.textContent = '保存しました';
      const p = ALL.find(function(x){ return x.productId===payload.productId; });
      if(p){ Object.keys(payload).forEach(function(k){ p[k]=payload[k]; }); }
      setTimeout(function(){ msg.textContent=''; }, 2500);
    })
    .withFailureHandler(function(e){
      btn.disabled = false;
      msg.className = 'msg err';
      msg.textContent = '失敗: '+e.message;
    })
    .adminSaveProduct(payload);
}

function load(){
  document.getElementById('list').innerHTML = '<div class="loading">読み込んでいます…</div>';
  google.script.run
    .withSuccessHandler(function(res){
      ALL = res.products;
      document.getElementById('stamp').textContent = res.updatedAt + ' 時点';
      render();
    })
    .withFailureHandler(function(e){
      document.getElementById('list').innerHTML =
        '<div class="loading">読み込みに失敗しました<br>'+esc(e.message)+'</div>';
    })
    .adminLoadProducts();
}

document.getElementById('q').addEventListener('input', render);
document.getElementById('filter').addEventListener('change', render);
document.getElementById('reload').addEventListener('click', load);
load();
</script>
</body>
</html>`;