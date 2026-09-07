/**
 * 03_Render.gs
 * 商品マスタと価格ログから、ページのHTMLを組み立てる。
 *
 * このファイルは「HTMLを作る」ことだけを担当する。
 * シートを読む処理とGitHubへ置く処理は 04_Build.gs と 02_Host.gs に、
 * 記事の原稿を読む処理は 07_Article.gs にある。
 *
 * 【形態によって主役の数字を変える】
 * パウダー … 1食分の量を自分で決められるので、1杯（タンパク質20g）単価が指標。
 * ドリンク … 1本を買い切るので、「1本で何g摂れるか」と「1本いくらか」を同格で出す。
 *            そのうえで「パウダー換算 1杯◯◯円」を添え、
 *            パウダーと同じものさしでも比べられるようにしている。
 *
 * パッケージは、商品マスタの画像URL列に値があれば写真、
 * 無ければ味と製法から決まる色ブロックを出す。
 *
 * 体験メモは、値が入っている商品にだけ表示する。
 *
 * デザインは protein-zukan-v4.html を元にしている。
 *
 * 【2026-08-28 の変更】
 * トップページの「読みもの」が、文字だけで置かれていたためリンクに見えなかった。
 * 商品カードと同じく、枠・背景・ボタンを持つカードに変えている。
 * 触れる面がどこかを、商品カードと同じ形で示すのが狙い。
 */

/* ============================================================
 * 描画（純粋関数）
 * GAS固有のAPIを使わない。ここだけをローカルでも動かして
 * 見た目を確認できるようにしてある。
 * ============================================================ */

/**
 * トップページに出す読みものの本数。
 * これを超えたぶんは /articles/ に送る。
 */
const INDEX_ARTICLE_COUNT = 3;

/**
 * サイト全体で使う設定。
 * 計測タグと問い合わせ先はここだけを直せば全ページに反映される。
 */
/**
 * 製法とURLの対応。
 * 日本語のままではURLに使えないので、ここで英字に変換する。
 * ここに無い製法は絞り込みページを作らない。
 */
const METHOD_SLUGS = {
  'WPC': 'wpc',
  'WPI': 'wpi',
  'WPH': 'wph',
  'ソイ': 'soy',
  'カゼイン': 'casein',
  'ミックス': 'mix'
};

function methodSlug_(method) {
  return METHOD_SLUGS[String(method || '').trim()] || '';
}

const SITE = {
  // Googleアナリティクスの測定ID。空文字にすればタグを出力しない。
  GA_ID: 'G-D3K1HK06SY',

  // お問い合わせフォーム（Googleフォーム）
  CONTACT_URL: 'https://forms.gle/ZYt9hZuNDHELT76C7'
};

/** HTMLエスケープ */
function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 3桁区切り */
function comma_(n) {
  if (n === null || n === undefined || n === '') return '';
  return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 前回のビルドからの順位の変動を、矢印で出す。
 * up=緑の↑、down=赤の↓、same=グレーの→。
 * 比べる前回の記録が無い（初回や新規商品）ときは null になり、何も出さない。
 */
function rankArrowHtml_(change) {
  if (change === 'up') return '<span class="rk-arrow rk-up" title="前回より順位アップ">↑</span>';
  if (change === 'down') return '<span class="rk-arrow rk-down" title="前回より順位ダウン">↓</span>';
  if (change === 'same') return '<span class="rk-arrow rk-same" title="前回から順位の変動なし">→</span>';
  return '';
}

/**
 * パッケージの色クラスを決める。
 * 味の文字列から推測し、当てはまらなければ製法で決める。
 * 画像を持たないので、色だけで棚の見分けをつける。
 */
function pkgClass_(product) {
  const flavor = String(product.flavor || '');
  const method = String(product.method || '');

  if (/ココア|カカオ|チョコ|ショコラ|カフェ|コーヒー/.test(flavor)) {
    return /リッチ|ビター|ダーク/.test(flavor) ? 'choco' : 'cocoa';
  }
  if (/バニラ|きなこ|キャラメル|ミルクティー|抹茶|バナナ/.test(flavor)) return 'van';
  if (/いちご|イチゴ|ストロベリー|ベリー|ピーチ|マスカット|グレープ/.test(flavor)) return 'straw';
  if (/ミルク|ヨーグルト|プレーン|無添加/.test(flavor)) return 'milk';

  if (method === 'WPI' || method === 'WPH') return 'wpi';
  if (method === 'ソイ') return 'van';

  return 'milk';
}

/**
 * パッケージに載せる短いラベル。
 * 商品IDが半角英字なので、そこから3行を組み立てる。
 * 例 exp-whey-milkchoco-3000 → EXP / WHEY / 3000G
 */
function pkgLabel_(product) {
  const parts = String(product.productId || '').split('-');
  const head = (parts[0] || '').toUpperCase();
  const mid = (parts[1] || '').toUpperCase();

  const unit = product.form === 'RTD' ? 'ML' : 'G';
  const size = product.capacity ? comma_(product.capacity) + unit : '';

  return [head, mid, size].filter(Boolean).join('<br>');
}

/**
 * 楽天の画像URLに配信サイズを指定する。
 * 既にサイズ指定が付いていれば付け替える。
 * 楽天以外のURL（手で入れたもの）はそのまま返す。
 */
function rakutenImage_(url, size) {
  const raw = String(url || '').trim();

  if (!raw) return '';
  if (raw.indexOf('image.rakuten.co.jp') === -1) return raw;

  const base = raw.replace(/\?_ex=\d+x\d+$/, '');
  return base + '?_ex=' + size + 'x' + size;
}

/**
 * パッケージの枠を描く。
 * 画像URLがあれば写真、無ければ色ブロックにする。
 * 全商品で画像が揃うとは限らないので、両方を残しておく。
 *
 * @param {Object} product
 * @param {number} size 配信画像の一辺（px）
 * @param {string} href 包む場合のリンク先（空なら div）
 */
function pkgBlock_(product, size, href) {
  const image = rakutenImage_(product.imageUrl, size);
  const tag = href ? 'a' : 'div';
  const attr = href ? ' href="' + esc_(href) + '"' : '';

  if (image) {
    const alt = [product.brand, product.series, product.flavor].filter(Boolean).join(' ');
    return '<' + tag + ' class="pkg photo"' + attr + '>' +
      '<img src="' + esc_(image) + '" alt="' + esc_(alt) + '" width="' + size + '" height="' + size + '" loading="lazy" decoding="async">' +
      '</' + tag + '>';
  }

  return '<' + tag + ' class="pkg ' + pkgClass_(product) + '"' + attr + '>' + pkgLabel_(product) + '</' + tag + '>';
}

/** 1袋で何食分か */
function servingCount_(product) {
  if (!product.capacity || !product.servingSize) return null;
  return Math.floor(product.capacity / product.servingSize);
}

/**
 * 価格推移のSVGを描く。
 * 点が2つ未満のときはグラフを描かず、集計中である旨を返す。
 */
function renderChart_(history) {
  if (!history || history.length < 2) {
    return '<p class="nodata">価格の推移は毎日1件ずつ記録しています。' +
      'グラフは数日ぶんが溜まってから表示されます。</p>';
  }

  const points = history.slice(-90);
  const values = points.map(function (h) { return h.price; });
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = (max - min) || 1;

  const W = 320;
  const H = 108;
  const top = 12;
  const bottom = 96;

  const coords = points.map(function (h, i) {
    const x = points.length === 1 ? 0 : (W * i) / (points.length - 1);
    const y = bottom - ((h.price - min) / span) * (bottom - top);
    return Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10;
  });

  const last = coords[coords.length - 1].split(',');

  return [
    '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="価格の推移">',
    '<line x1="0" y1="20" x2="' + W + '" y2="20" stroke="#E3E4E8"/>',
    '<line x1="0" y1="64" x2="' + W + '" y2="64" stroke="#E3E4E8"/>',
    '<line x1="0" y1="100" x2="' + W + '" y2="100" stroke="#E3E4E8"/>',
    '<polyline fill="none" stroke="#0D0E10" stroke-width="1.8" stroke-linejoin="round" points="' + coords.join(' ') + '"/>',
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4.5" fill="#2F5CFF" stroke="#0D0E10" stroke-width="1.8"/>',
    '<text x="2" y="15" font-size="8.5" fill="#82858C" font-family="Archivo">' + comma_(max) + '円</text>',
    '<text x="2" y="108" font-size="8.5" fill="#82858C" font-family="Archivo">' + comma_(min) + '円</text>',
    '</svg>'
  ].join('\n');
}

/**
 * JSON-LD構造化データを <script> タグにして返す。
 * Googleの検索結果でリッチリザルト（価格・パンくず等）を出すために使う。
 */
function jsonLd_(obj) {
  return '<script type="application/ld+json">' + JSON.stringify(obj) + '</script>';
}

/**
 * ページ共通のhead。
 *
 * @param {string} title
 * @param {string} description
 * @param {string} canonical
 * @param {string} [ogImage] SNSシェア時に出す画像URL。無ければ画像なしで表示される。
 * @param {string} [ogType] 'website' | 'article' 等。省略時は 'website'。
 */
function htmlHead_(title, description, canonical, ogImage, ogType) {
  return [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + esc_(title) + '</title>',
    '<meta name="description" content="' + esc_(description) + '">',
    canonical ? '<link rel="canonical" href="' + esc_(canonical) + '">' : '',
    // OGP。X（Twitter）やLINEでシェアされたときに、タイトル・説明・画像を出すため。
    '<meta property="og:site_name" content="プロテイン図鑑">',
    '<meta property="og:type" content="' + esc_(ogType || 'website') + '">',
    '<meta property="og:title" content="' + esc_(title) + '">',
    '<meta property="og:description" content="' + esc_(description) + '">',
    canonical ? '<meta property="og:url" content="' + esc_(canonical) + '">' : '',
    ogImage ? '<meta property="og:image" content="' + esc_(ogImage) + '">' : '',
    '<meta property="og:locale" content="ja_JP">',
    '<meta name="twitter:card" content="' + (ogImage ? 'summary_large_image' : 'summary') + '">',
    '<meta name="twitter:title" content="' + esc_(title) + '">',
    '<meta name="twitter:description" content="' + esc_(description) + '">',
    ogImage ? '<meta name="twitter:image" content="' + esc_(ogImage) + '">' : '',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;800;900&family=Zen+Kaku+Gothic+New:wght@500;700;900&family=Noto+Sans+JP:wght@400;500&display=swap" rel="stylesheet">',
    '<style>',
    SITE_CSS,
    '</style>',
    SITE.GA_ID ? '<script async src="https://www.googletagmanager.com/gtag/js?id=' + SITE.GA_ID + '"></script>' : '',
    SITE.GA_ID ? '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","' + SITE.GA_ID + '");</script>' : '',
    '</head>',
    '<body>'
  ].filter(Boolean).join('\n');
}

/** v4のスタイルから、商品ページに必要な部分だけを取り出したもの */
const SITE_CSS = [
  ':root{--paper:#F8F9FB;--ink:#0D0E10;--ink-2:#33363C;--sub:#82858C;--hair:#E3E4E8;--stone:#EEEFF2;--acc:#2F5CFF;--acc-d:#1A3FCC}',
  '*{box-sizing:border-box;margin:0;padding:0}',
  'body{background:var(--paper);color:var(--ink);font-family:"Noto Sans JP",system-ui,sans-serif;font-size:13.5px;line-height:1.8;-webkit-font-smoothing:antialiased}',
  'h1,h2,h3{font-family:"Zen Kaku Gothic New",sans-serif;letter-spacing:-.01em}',
  '.n{font-family:"Archivo",sans-serif;font-weight:800;font-feature-settings:"tnum";letter-spacing:-.03em}',
  'a{color:inherit;text-decoration:none}',
  '.ticker{background:var(--ink);color:#fff;font-family:"Zen Kaku Gothic New";font-weight:700;font-size:10.5px;letter-spacing:.03em;padding:7px 0;overflow:hidden;white-space:nowrap}',
  '.ticker span{display:inline-block;padding-left:100%;animation:tick 20s linear infinite}',
  '@media (prefers-reduced-motion:reduce){.ticker span{animation:none;padding-left:20px}}',
  '@keyframes tick{0%{transform:translateX(0)}100%{transform:translateX(-100%)}}',
  '.wrap{max-width:660px;margin:0 auto;padding:0 20px 80px}',
  '.hd{display:flex;align-items:flex-end;justify-content:space-between;padding:24px 0 15px;border-bottom:2px solid var(--ink);margin-bottom:20px}',
  '.logo{font-family:"Zen Kaku Gothic New";font-weight:900;font-size:18px;line-height:1}',
  '.logo h1{font:inherit;letter-spacing:inherit;margin:0}',
  '.logo small{display:block;font-family:"Noto Sans JP";font-weight:400;font-size:10px;letter-spacing:.04em;color:var(--sub);margin-top:6px}',
  '.upd{text-align:right;font-size:10px;color:var(--sub);line-height:1.6}',
  '.upd b{display:block;color:var(--ink);font-weight:700;font-size:11.5px;font-family:"Zen Kaku Gothic New"}',
  '.crumb{font-size:10.5px;color:var(--sub);margin-bottom:11px}',
  '.pkg{aspect-ratio:3/4;border-radius:2px;display:flex;flex-direction:column;justify-content:flex-end;padding:9px;color:#fff;font-family:"Archivo";font-weight:600;font-size:8.5px;letter-spacing:.1em;line-height:1.5}',
  '.pkg.cocoa{background:linear-gradient(155deg,#7E5433,#3E2612)}',
  '.pkg.van{background:linear-gradient(155deg,#EFE2BE,#BFA469);color:#4A3B1C}',
  '.pkg.straw{background:linear-gradient(155deg,#E7A0AF,#B84763)}',
  '.pkg.milk{background:linear-gradient(155deg,#F2F3F5,#C4C9CF);color:#3B4249}',
  '.pkg.choco{background:linear-gradient(155deg,#5E3D22,#2C1B0E)}',
  '.pkg.wpi{background:linear-gradient(155deg,#E4E9C4,#B3BC63);color:#3D4212}',
  '.pkg.photo{background:#fff;border:1px solid var(--hair);padding:7px;color:inherit}',
  '.pkg.photo img{width:100%;height:100%;object-fit:contain;display:block}',
  '.phero{padding:6px 0 26px;border-bottom:2px solid var(--ink)}',
  '.phero .grid{display:grid;grid-template-columns:114px 1fr;gap:20px;align-items:start}',
  '.phero .pkg{width:114px;margin:0}',
  '.phero h1{font-size:20px;font-weight:900;line-height:1.42}',
  '.spec{font-size:10.5px;color:var(--sub);margin-top:7px;line-height:1.7}',
  '.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:11px}',
  '.tg{font-size:10px;color:var(--ink-2);border:1px solid var(--hair);padding:1px 8px;border-radius:2px}',
  '.figure{display:flex;align-items:flex-end;gap:13px;margin-top:24px;padding-top:20px;border-top:1px solid var(--hair)}',
  '.figure .big{font-size:64px;line-height:.82;letter-spacing:-.045em}',
  '.figure .side{padding-bottom:6px}',
  '.figure .side .u{font-family:"Zen Kaku Gothic New";font-weight:700;font-size:13px}',
  '.figure .side .rk2{font-size:10.5px;color:var(--sub);margin-top:2px}',
  '.duo{display:flex;gap:30px;flex-wrap:wrap;margin-top:24px;padding-top:20px;border-top:1px solid var(--hair)}',
  '.duo .cell{display:flex;align-items:flex-end;gap:9px}',
  '.duo .v{font-size:52px;line-height:.82;letter-spacing:-.045em}',
  '.duo .lab{padding-bottom:5px}',
  '.duo .lab .u{font-family:"Zen Kaku Gothic New";font-weight:700;font-size:12.5px;display:block}',
  '.duo .lab .s{font-size:10.5px;color:var(--sub);display:block;margin-top:2px}',
  '.per20{font-size:11px;color:var(--sub);margin-top:13px}',
  '.per20 b{font-family:"Archivo";font-weight:800;color:var(--ink-2);font-size:13px}',
  '.mkbar{height:3px;background:var(--stone);margin-top:15px;position:relative}',
  '.mkbar i{position:absolute;left:0;top:0;height:100%;background:var(--ink)}',
  '.mkbar b{position:absolute;top:-4px;width:11px;height:11px;background:var(--acc);border:2px solid var(--ink);border-radius:50%;margin-left:-5px}',
  '.mklab{display:flex;justify-content:space-between;font-size:10px;color:var(--sub);margin-top:8px}',
  'section{margin-top:34px}',
  '.sh{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:2px solid var(--ink);padding-bottom:8px;margin-bottom:2px}',
  '.sh h2{font-size:16px;font-weight:900}',
  '.sh span{font-size:10.5px;color:var(--sub)}',
  '.shop{display:flex;align-items:center;gap:12px;padding:15px 0;border-bottom:1px solid var(--hair)}',
  '.shop.best{background:linear-gradient(90deg,rgba(47,92,255,.12),transparent 78%);margin:0 -12px;padding:15px 12px}',
  '.shop .s1{font-family:"Zen Kaku Gothic New";font-weight:700;font-size:13.5px}',
  '.shop .s1 em{font-style:normal;font-size:10px;background:var(--ink);color:#fff;padding:2px 6px;margin-left:7px;vertical-align:2px}',
  '.shop .s2{font-size:10px;color:var(--sub)}',
  '.shop .pr{margin-left:auto;text-align:right;margin-right:4px}',
  '.shop .pr .v{font-size:23px}',
  '.shop .pr .u{font-size:10.5px;font-weight:500;color:var(--sub);margin-left:1px}',
  '.btn{display:inline-block;background:var(--ink);color:#fff;font-family:"Zen Kaku Gothic New";font-weight:700;font-size:12px;padding:10px 17px;white-space:nowrap;border-radius:2px}',
  '.btn:hover{background:var(--ink-2)}',
  '.btn.acc{background:var(--acc);color:#fff}',
  '.btn.acc:hover{background:var(--acc-d)}',
  '.chart{margin-top:32px}',
  '.chart .ch{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid var(--ink);padding-bottom:8px;margin-bottom:14px}',
  '.chart .ch b{font-family:"Zen Kaku Gothic New";font-size:16px;font-weight:900}',
  '.chart .ch span{font-size:10.5px;color:var(--sub)}',
  'svg{display:block;width:100%;height:auto}',
  '.nodata{font-size:11px;color:var(--sub);background:var(--stone);padding:14px 16px}',
  '.note{font-size:10.5px;color:var(--sub);margin-top:8px}',
  '.auto{font-size:10.5px;color:var(--sub);border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);padding:9px 0;margin:20px 0}',
  '.row{display:grid;grid-template-columns:76px 1fr;gap:16px;padding:20px 0;border-bottom:1px solid var(--hair)}',
  '.row .pkg{margin:0;width:76px}',
  '.rtop{margin-bottom:6px}',
  '.mark{display:inline-block;font-family:"Zen Kaku Gothic New";font-weight:700;font-size:10.5px;background:var(--acc);color:#fff;padding:2px 8px}',
  '.rname{font-family:"Zen Kaku Gothic New";font-weight:700;font-size:14.5px;line-height:1.45}',
  '.rbrand{font-size:10.5px;color:var(--sub);margin:2px 0 9px}',
  '.pl{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-top:10px}',
  '.cup{display:flex;align-items:baseline;gap:3px}',
  '.cup .v{font-size:28px;line-height:.9}',
  '.cup .u{font-size:11px;font-weight:500;color:var(--ink-2);font-family:"Zen Kaku Gothic New"}',
  '.tot{font-size:10.5px;color:var(--sub);margin-top:4px}',
  '.tot b{font-family:"Archivo";font-weight:800;color:var(--ink-2);font-size:12.5px}',
  '.exp{background:var(--stone);padding:17px 19px;margin-top:26px}',
  '.exp h3{font-family:"Zen Kaku Gothic New";font-weight:900;font-size:12px;letter-spacing:.02em;margin-bottom:7px}',
  '.exp p{font-size:12.5px;line-height:1.9;white-space:pre-wrap}',
  '.exp .who{font-size:10px;color:var(--sub);margin-top:9px}',
  '.rank{font-family:"Archivo";font-weight:900;font-size:15px;color:var(--sub);width:26px;flex:none;padding-top:2px}',
  '.rk-arrow{display:inline-block;font-weight:900;margin-left:5px}',
  '.rk-up{color:#2E7D46}',
  '.rk-down{color:#C0392B}',
  '.rk-same{color:var(--sub)}',
  '.lrow{display:grid;grid-template-columns:26px 76px 1fr;gap:14px;padding:20px 0;border-bottom:1px solid var(--hair);align-items:start}',
  '.lrow .pkg{margin:0;width:76px}',
  '.lrow.first .rank{color:var(--ink)}',
  '.lead{font-size:12.5px;color:var(--ink-2);margin:14px 0 4px;line-height:1.9}',
  '.art{padding-top:6px}',
  '.art h1{font-size:25px;font-weight:900;line-height:1.5;margin-bottom:12px}',
  '.art .meta{font-size:10.5px;color:var(--sub);border-bottom:2px solid var(--ink);padding-bottom:14px;margin-bottom:26px}',
  '.art .stand{font-size:14px;line-height:2;color:var(--ink-2);margin-bottom:30px}',
  '.art h2{font-size:18px;font-weight:900;margin:40px 0 14px;padding-bottom:8px;border-bottom:2px solid var(--ink)}',
  '.art h3{font-size:14.5px;font-weight:700;margin:28px 0 8px}',
  '.art p{margin-bottom:17px;line-height:2.05}',
  '.art strong{font-weight:700;background:linear-gradient(transparent 62%,rgba(47,92,255,.16) 62%)}',
  '.art ul,.art ol{margin:0 0 18px 20px}',
  '.art li{margin-bottom:6px;line-height:1.95}',
  '.art table{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:12px}',
  '.art th{text-align:left;font-family:"Zen Kaku Gothic New";font-weight:700;border-bottom:2px solid var(--ink);padding:8px 6px}',
  '.art td{border-bottom:1px solid var(--hair);padding:9px 6px}',
  '.art td:not(:first-child),.art th:not(:first-child){text-align:right;white-space:nowrap}',
  '.art .cap{font-size:10.5px;color:var(--sub);margin:-6px 0 20px}',
  '.art hr{border:0;border-top:1px solid var(--hair);margin:34px 0}',
  '.embed{margin:26px 0}',
  '.embed .ttl{font-family:"Zen Kaku Gothic New";font-weight:900;font-size:12px;border-bottom:2px solid var(--ink);padding-bottom:7px;margin-bottom:2px}',
  '.prc{display:block;border:1px solid var(--hair);border-left:3px solid var(--sub);border-radius:2px;padding:17px 19px;margin:26px 0;background:#fff}',
  '.prc:hover{border-color:var(--ink)}',
  '.prc:hover .btn.acc{background:var(--acc-d)}',
  '.prtag{display:inline-block;font-family:"Zen Kaku Gothic New";font-weight:700;font-size:10px;letter-spacing:.08em;color:#fff;background:var(--sub);padding:2px 8px;border-radius:2px;margin-bottom:9px}',
  '.prc .pname{font-family:"Zen Kaku Gothic New";font-weight:700;font-size:14.5px;line-height:1.5}',
  '.prc .pnote{font-size:12.5px;color:var(--ink-2);line-height:1.9;margin-top:6px}',
  '.prc .pfoot{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;margin-top:14px}',
  '.prc.has-img{display:grid;grid-template-columns:108px 1fr;gap:18px;align-items:start}',
  '.prc .pimg{width:108px;aspect-ratio:3/4;border:1px solid var(--hair);border-radius:2px;padding:9px;background:#fff}',
  '.prc .pimg img{width:100%;height:100%;object-fit:contain;display:block}',
  // 読みもののカード。
  // 以前は文字だけを並べていたため、リンクだと気づかれなかった。
  // 商品カードと同じ「枠＋ボタン」の形にして、触れる面を明示する。
  '.reads{margin-bottom:34px}',
  '.read{display:flex;align-items:center;gap:14px;background:#fff;border:1px solid var(--hair);border-left:3px solid var(--acc);border-radius:2px;padding:16px 18px;margin-top:12px}',
  '.read:hover{border-color:var(--ink);border-left-color:var(--acc-d)}',
  '.read .rtx{flex:1;min-width:0}',
  '.read .rt2{font-family:"Zen Kaku Gothic New";font-weight:700;font-size:14.5px;line-height:1.5}',
  '.read .rd{font-size:11px;color:var(--sub);margin-top:4px;line-height:1.7}',
  '.read .rgo{flex:none;display:inline-block;background:var(--ink);color:#fff;font-family:"Zen Kaku Gothic New";font-weight:700;font-size:12px;padding:9px 15px;white-space:nowrap;border-radius:2px}',
  '.read:hover .rgo{background:var(--acc-d)}',
  '.sortb{display:flex;gap:6px;flex-wrap:wrap}',
  '.sb{font-family:"Zen Kaku Gothic New";font-weight:700;font-size:10.5px;color:var(--sub);background:#fff;border:1px solid var(--hair);border-radius:2px;padding:5px 10px;white-space:nowrap}',
  '.sb:hover{border-color:var(--ink);color:var(--ink)}',
  '.sb.on{background:var(--ink);color:#fff;border-color:var(--ink)}',
  '.sibs{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}',
  '.sib{display:block;background:#fff;border:1px solid var(--hair);border-radius:2px;padding:10px 13px;min-width:104px}',
  '.sib:hover{border-color:var(--ink)}',
  '.sib b{display:block;font-family:"Zen Kaku Gothic New";font-weight:700;font-size:12.5px;line-height:1.4}',
  '.sib s{display:block;text-decoration:none;font-size:10px;color:var(--sub);margin-top:2px}',
  '.sib em{font-style:normal;font-family:"Archivo";font-weight:800;font-size:14px;color:var(--ink);margin-top:5px;display:block}',
  '.sib em i{font-style:normal;font-family:"Noto Sans JP";font-weight:400;font-size:10px;color:var(--sub);margin-left:2px}',
  '.chiplab{font-size:10.5px;color:var(--sub);margin-top:16px}',
  '.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}',
  '.chip{display:inline-block;background:#fff;border:1px solid var(--hair);border-radius:2px;padding:7px 13px;font-family:"Zen Kaku Gothic New";font-weight:700;font-size:12px;color:var(--ink)}',
  '.chip:hover{border-color:var(--ink)}',
  '.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}',
  '.chip.on em{color:#fff}',
  '.chip em{font-style:normal;font-family:"Archivo";font-weight:600;font-size:10.5px;color:var(--sub);margin-left:6px}',
  '.more{display:block;text-align:center;font-family:"Zen Kaku Gothic New";font-weight:700;font-size:12.5px;color:var(--ink-2);border:1px solid var(--hair);border-radius:2px;padding:13px;margin-top:12px}',
  '.more:hover{border-color:var(--ink);color:var(--ink)}',
  'footer{border-top:2px solid var(--ink);margin-top:54px;padding-top:18px;font-size:10px;color:var(--sub);line-height:1.9}',
  '.fnav{display:flex;gap:16px;flex-wrap:wrap;margin-top:14px;padding-top:14px;border-top:1px solid var(--hair)}',
  '.fnav a{font-family:"Zen Kaku Gothic New";font-weight:700;font-size:11px;color:var(--ink-2)}',
  '.fnav a:hover{color:var(--ink)}'
].join('\n');

/**
 * 商品カード1枚を描く。記事への埋め込みにも使う。
 *
 * @param {Object} c {product系のフィールド, unitValue, price, href, per20g}
 */
function renderItemCard_(c) {
  const name = [c.brand, c.series, c.flavor].filter(Boolean).join(' ');
  const size = c.capacity ? comma_(c.capacity) + (c.form === 'RTD' ? 'ml' : 'g') : '';
  const isRtd = c.form === 'RTD';
  const unitLabel = isRtd ? '円/本' : '円/杯';

  const sub = isRtd && c.proteinPerServing
    ? 'タンパク質 <b>' + c.proteinPerServing + '</b>g／本'
      + (c.per20g ? '　パウダー換算 1杯 <b>' + Math.round(c.per20g) + '</b>円' : '')
    : (c.price ? '楽天市場 <b>' + comma_(c.price) + '</b>円' : '');

  return [
    '<div class="row">',
    pkgBlock_(c, 200, c.href),
    '<div>',
    '<div class="rname"><a href="' + esc_(c.href) + '">' + esc_(name) + '</a></div>',
    '<div class="rbrand">' + esc_([c.maker, size, c.method].filter(Boolean).join(' ／ ')) + '</div>',
    '<div class="pl"><div>',
    '<div class="cup"><span class="v n">' + c.unitValue + '</span><span class="u">' + unitLabel + '</span></div>',
    sub ? '<div class="tot">' + sub + '</div>' : '',
    '</div><a class="btn" href="' + esc_(c.href) + '">くわしく</a></div>',
    '</div></div>'
  ].filter(Boolean).join('\n');
}

/**
 * 記事ページのHTMLを組み立てる。
 *
 * @param {Object} article {slug, title, description, publishedLabel, updatedLabel, lead}
 * @param {string} bodyHtml 本文（Markdownから変換済み・商品カード埋め込み済み）
 */
function buildArticleHtml_(article, bodyHtml) {
  const canonical = 'https://proteinzukan.com/' + article.slug + '/';

  const articleLd = jsonLd_({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    url: canonical,
    inLanguage: 'ja',
    isPartOf: { '@type': 'WebSite', name: 'プロテイン図鑑', url: 'https://proteinzukan.com/' },
    publisher: { '@type': 'Organization', name: 'プロテイン図鑑' }
  });

  return [
    htmlHead_(
      article.title + '｜プロテイン図鑑',
      article.description,
      canonical,
      '',
      'article'
    ),
    '<div class="wrap">',
    '<div class="hd">',
    '<div class="logo"><a href="/">プロテイン図鑑</a><small>毎日更新のプロテイン価格比較</small></div>',
    '</div>',
    '<div class="crumb"><a href="/">トップ</a> ／ <a href="/articles/">読みもの</a></div>',
    '<article class="art">',
    '<h1>' + esc_(article.title) + '</h1>',
    '<div class="meta">' +
      (article.publishedLabel ? '公開 ' + esc_(article.publishedLabel) : '') +
      (article.updatedLabel ? '　更新 ' + esc_(article.updatedLabel) : '') +
    '</div>',
    bodyHtml,
    '</article>',
    '<footer>',
    '記事中の価格は執筆時点のものです。各商品ページの価格は毎日6時に更新しています。<br>',
    '成分値はメーカー公表値です。購入前にパッケージの表示をご確認ください。<br>',
    '当サイトはアフィリエイトプログラムを利用しています。',
    footerNav_(),
    '</footer>',
    '</div>',
    articleLd,
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
}

/**
 * 商品ページから案内する関連記事。
 *
 * 記事のタイトル・説明文はここには持たせない。
 * ビルド時に渡される articlesByHref（実際の記事一覧）から都度引くことで、
 * 記事を書き直したときにここが古いまま残らないようにしている。
 *
 * パウダーとドリンクで悩みどころが違うので、形態ごとに出し分ける。
 * 「なぜ20gで比べるか」はどちらにも関係するので共通で出す。
 */
const RELATED_ARTICLE_HREFS = {
  common: ['/naze-20g/'],
  powder: ['/protein-youryou/', '/nomu-pace/'],
  rtd: ['/shokuba-protein/', '/shucchou-protein/']
};

function relatedArticles_(isRtd, articlesByHref) {
  if (!articlesByHref) return [];

  const hrefs = RELATED_ARTICLE_HREFS.common.concat(isRtd ? RELATED_ARTICLE_HREFS.rtd : RELATED_ARTICLE_HREFS.powder);

  return hrefs.map(function (href) { return articlesByHref[href]; }).filter(Boolean);
}

/**
 * 商品ページのHTMLを組み立てる。
 *
 * @param {Object} product 商品マスタ1行
 * @param {Object|null} price 最新の価格（無ければ null）
 * @param {Array} history 価格の履歴 [{date, price}]
 * @param {Object} ctx {rank, total, minPer20g, maxPer20g, cheaper:[], updatedLabel}
 * @param {Object} [articlesByHref] 記事一覧をhrefで引けるようにしたもの。「あわせて読みたい」に使う。
 */
function buildItemHtml_(product, price, history, ctx, articlesByHref) {
  const name = [product.brand, product.series, product.flavor].filter(Boolean).join(' ');
  const sizeLabel = product.capacity
    ? comma_(product.capacity) + (product.form === 'RTD' ? 'ml' : 'g')
    : '';
  const fullName = name + (sizeLabel ? ' ' + sizeLabel : '');

  const isRtd = product.form === 'RTD';
  const unitValue = isRtd
    ? (price ? price.pricePerUnit : null)
    : (price ? price.pricePer20g : null);
  const unitLabel = isRtd ? '円 / 1本あたり' : '円 / 1杯あたり';

  // 見出しまわり
  const specLines = [];
  if (product.method) specLines.push(product.method);
  if (product.servingSize && product.proteinPerServing) {
    specLines.push('1食' + product.servingSize + 'g中 タンパク質' + product.proteinPerServing + 'g');
  }
  const spec2 = [];
  const servings = servingCount_(product);
  if (servings && !isRtd) spec2.push('約' + servings + '食分');
  if (product.maker) spec2.push(product.maker);

  const tags = (product.tags || []).slice(0, 5).map(function (t) {
    return '<span class="tg">' + esc_(t) + '</span>';
  }).join('');

  // 位置を示すバー
  let bar = '';
  if (unitValue !== null && ctx.minPer20g !== null && ctx.maxPer20g !== null && ctx.maxPer20g > ctx.minPer20g) {
    const ratio = Math.max(0, Math.min(1, (unitValue - ctx.minPer20g) / (ctx.maxPer20g - ctx.minPer20g)));
    const pct = Math.round(ratio * 100);
    bar = [
      '<div class="mkbar"><i style="width:' + pct + '%"></i><b style="left:' + pct + '%"></b></div>',
      '<div class="mklab"><span>いちばん安い ' + ctx.minPer20g + '円</span>' +
      '<span>いちばん高い ' + ctx.maxPer20g + '円</span></div>'
    ].join('\n');
  }

  // 販売店
  let shops;
  if (price) {
    const postage = price.postage === '込' ? '送料込み' : '送料別';
    const qty = isRtd && price.quantity ? ' ／ ' + price.quantity + '本入り' : '';
    shops = [
      '<div class="shop best">',
      '<div><div class="s1">楽天市場<em>最安</em></div>',
      '<div class="s2">' + esc_(postage + qty) + '</div>',
      '<div class="s2">' + esc_(price.shopName || '') + '</div></div>',
      '<div class="pr"><span class="v n">' + comma_(price.price) + '</span><span class="u">円</span></div>',
      '<a class="btn acc" href="' + esc_(price.url) + '" target="_blank" rel="nofollow noopener"' +
        ' onclick="gtag(\'event\',\'affiliate_click\',{shop:\'rakuten\',item_id:\'' + esc_(product.productId) + '\'})">見る</a>',
      '</div>',
      '<p class="note">Amazon・Yahoo!ショッピングの価格は準備中です。</p>'
    ].join('\n');
  } else {
    shops = '<p class="nodata">この商品の価格はまだ取得できていません。' +
      '公式サイトやお店でご確認ください。</p>';
  }

  // 公式ストア（ASP案件）のPRカード。
  // 商品マスタの「公式URL」列に値が入っている商品だけ、楽天リンクの下に添える。
  // 値が空のあいだは何も表示しない（renderPrCard_の「未設定」表示を出さないよう、ここで先に判定する）。
  const officialCard = product.officialUrl ? renderPrCard_({
    name: fullName + 'を公式サイトで見る',
    url: product.officialUrl,
    note: product.aspProgram ? product.aspProgram + '経由の公式ストアです。' : ''
  }) : '';

  const related = relatedArticles_(isRtd, articlesByHref);

  // 同じ形態で安いもの。
  //
  // 差額はタンパク質20gあたりで出す。1本あたりで比べると、
  // タンパク質の少ないドリンクが「安い」と出てしまい、実際には得にならない。
  // 主役の数字はその商品の形態に合わせつつ、差額の根拠は換算値で示す。
  const cheaperRows = (ctx.cheaper || []).map(function (c) {
    const basis = ctx.compareBasis;
    const cv = (c.compareValue !== null && c.compareValue !== undefined)
      ? c.compareValue : c.unitValue;
    const diff = (basis !== null && basis !== undefined) ? Math.round(basis - cv) : null;

    const cName = [c.brand, c.series, c.flavor].filter(Boolean).join(' ');
    const cSize = c.capacity ? comma_(c.capacity) + (c.form === 'RTD' ? 'ml' : 'g') : '';
    const cIsRtd = c.form === 'RTD';
    const cUnitLabel = cIsRtd ? '円/本' : '円/杯';

    // ドリンクは1本の値段だけだと比較にならないので、
    // タンパク質量とパウダー換算を必ず添える。
    const cSub = cIsRtd
      ? ('タンパク質 <b>' + (c.proteinPerServing || '−') + '</b>g／本'
        + (c.per20g ? '　パウダー換算 1杯 <b>' + Math.round(c.per20g) + '</b>円' : ''))
      : (c.price ? '楽天市場 <b>' + comma_(c.price) + '</b>円' : '');

    return [
      '<div class="row">',
      pkgBlock_(c, 200, c.href),
      '<div>',
      diff ? '<div class="rtop"><span class="mark">タンパク質20gあたり ' + diff + '円 安い</span></div>' : '',
      '<div class="rname"><a href="' + esc_(c.href) + '">' + esc_(cName) + '</a></div>',
      '<div class="rbrand">' + esc_([c.maker, cSize, c.method].filter(Boolean).join(' ／ ')) + '</div>',
      '<div class="pl"><div>',
      '<div class="cup"><span class="v n">' + c.unitValue + '</span><span class="u">' + cUnitLabel + '</span></div>',
      cSub ? '<div class="tot">' + cSub + '</div>' : '',
      '</div><a class="btn" href="' + esc_(c.href) + '">くわしく</a></div>',
      '</div></div>'
    ].filter(Boolean).join('\n');
  }).join('\n');

  const crumb = [product.form, product.maker, product.brand].filter(Boolean).join(' ／ ');

  const description = fullName + 'の1杯あたりの値段と、楽天市場での最安値。' +
    'タンパク質20gあたりの価格で他の商品と比較できます。';

  const ogImage = rakutenImage_(product.imageUrl, 600);

  // Product/Offer構造化データ。検索結果に価格を出すための情報。
  const productLd = price ? jsonLd_({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: fullName,
    brand: product.maker || product.brand ? { '@type': 'Brand', name: product.maker || product.brand } : undefined,
    image: ogImage || undefined,
    description: description,
    offers: {
      '@type': 'Offer',
      url: price.url,
      priceCurrency: 'JPY',
      price: price.price,
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition'
    }
  }) : '';

  return [
    htmlHead_(fullName + '｜プロテイン図鑑', description, product.canonical || '', ogImage),
    '<div class="wrap">',
    '<div class="hd">',
    '<div class="logo"><a href="/">プロテイン図鑑</a><small>毎日更新のプロテイン価格比較</small></div>',
    '<div class="upd"><b>' + esc_(ctx.updatedLabel) + '</b></div>',
    '</div>',
    '<div class="crumb">' + esc_(crumb) + '</div>',

    '<div class="phero">',
    '<div class="grid">',
    pkgBlock_(product, 300, ''),
    '<div>',
    '<h1>' + esc_(name) + (sizeLabel ? '<br>' + esc_(sizeLabel) : '') + '</h1>',
    '<div class="spec">' + esc_(specLines.join(' ／ ')) +
      (spec2.length ? '<br>' + esc_(spec2.join(' ／ ')) : '') + '</div>',
    tags ? '<div class="tags">' + tags + '</div>' : '',
    '</div>',
    '</div>',

    unitValue === null
      ? '<p class="nodata" style="margin-top:20px">価格を取得できていないため、1杯あたりの値段は表示できません。</p>'
      : (isRtd ? [
        // ドリンクは「1本で何g摂れるか」と「1本いくらか」を同じ大きさで並べる。
        // どちらが大事かは人によって違うので、どちらも主役にする。
        '<div class="duo">',
        product.proteinPerServing ? [
          '<div class="cell">',
          '<div class="v n">' + product.proteinPerServing + '</div>',
          '<div class="lab"><span class="u">g</span>',
          '<span class="s">タンパク質 / 1本</span></div>',
          '</div>'
        ].join('\n') : '',
        '<div class="cell">',
        '<div class="v n">' + unitValue + '</div>',
        '<div class="lab"><span class="u">円</span>',
        '<span class="s">1本あたり</span></div>',
        '</div>',
        '</div>',
        ctx.per20g ? '<div class="per20">パウダー換算 1杯 <b>' + Math.round(ctx.per20g) + '</b>円</div>' : '',
        ctx.rank ? '<div class="per20">ドリンク' + ctx.total + '商品中 <b>' + ctx.rank + '</b>位（1本あたりの安い順）' +
          rankArrowHtml_(ctx.rankChange) + '</div>' : '',
        // 1本あたりの順位だけだと、下の「これより安いもの」と食い違って見える。
        // 換算後の順位も並べて、どちらのものさしで何位かを分かるようにする。
        ctx.rankPer20g ? '<div class="per20">' + ctx.totalPer20g + '商品中 <b>' + ctx.rankPer20g +
          '</b>位（タンパク質20gあたりの安い順）' + rankArrowHtml_(ctx.rankPer20gChange) + '</div>' : '',
        bar
      ].filter(Boolean).join('\n') : [
        '<div class="figure">',
        '<div class="big n">' + unitValue + '</div>',
        '<div class="side">',
        '<div class="u">' + unitLabel + '</div>',
        ctx.rank ? '<div class="rk2">' + esc_(product.form) + ctx.total + '商品中 <span class="n">' + ctx.rank + '</span>位' +
          rankArrowHtml_(ctx.rankChange) + '</div>' : '',
        '</div>',
        '</div>',
        bar
      ].join('\n')),
    '</div>',

    product.experience ? [
      '<div class="exp">',
      '<h3>飲んでみて</h3>',
      '<p>' + esc_(product.experience) + '</p>',
      '<div class="who">運営者が実際に使ったものだけ書いています</div>',
      '</div>'
    ].join('\n') : '',

    '<section>',
    '<div class="sh"><h2>どこで買うのが安い？</h2><span>' + esc_(ctx.updatedLabel) + '時点</span></div>',
    shops,
    '</section>',

    officialCard,

    // 同じシリーズの他の味。
    // この商品を見ている人が次に知りたいのは、別ブランドより先に
    // 「同じものに他の味があるか」なので、比較より前に置く。
    (ctx.siblings && ctx.siblings.length) ? [
      '<section>',
      '<div class="sh"><h2>同じシリーズの他の味</h2><span>1杯あたりの安い順</span></div>',
      '<div class="sibs">',
      ctx.siblings.map(function (sib) {
        const size = sib.capacity
          ? comma_(sib.capacity) + (sib.form === 'RTD' ? 'ml' : 'g')
          : '';
        const unit = sib.form === 'RTD' ? '円/本' : '円/杯';

        return '<a class="sib" href="' + esc_(sib.href) + '">' +
          '<b>' + esc_(sib.flavor) + '</b>' +
          (size ? '<s>' + esc_(size) + '</s>' : '') +
          '<em>' + sib.unitValue + '<i>' + unit + '</i></em>' +
          '</a>';
      }).join(''),
      '</div>',
      '<p class="note">ここに出ているのは、価格を取得できている味だけです。</p>',
      '</section>'
    ].join('\n') : '',

    '<div class="chart">',
    '<div class="ch"><b>価格の推移</b><span>毎日6時の最安値</span></div>',
    renderChart_(history),
    '</div>',

    '<p class="auto">このページは商品マスタと価格ログから自動生成しています。価格は毎日6時に取得しています。</p>',

    cheaperRows ? [
      '<section>',
      '<div class="sh"><h2>これより安いもの</h2><span>タンパク質20gあたりで比較</span></div>',
      cheaperRows,
      '</section>'
    ].join('\n') : '',

    // あわせて読みたい記事。
    // この商品を見ている人が次に迷いそうなこと（容量選び・持ち運びなど）を、
    // 実際に使った記録として案内する。
    related.length ? [
      '<section class="reads">',
      '<div class="sh"><h2>あわせて読みたい</h2></div>',
      related.map(function (a) {
        return '<a class="read" href="' + esc_(a.href) + '">' +
          '<div class="rtx">' +
          '<div class="rt2">' + esc_(a.title) + '</div>' +
          (a.description ? '<div class="rd">' + esc_(a.description) + '</div>' : '') +
          '</div>' +
          '<span class="rgo">読む</span>' +
          '</a>';
      }).join('\n'),
      '</section>'
    ].join('\n') : '',

    '<footer>',
    '価格は楽天市場のAPIから毎日6時に取得しています。表示時点で在庫や価格が変わっている場合があります。<br>',
    '成分値はメーカー公表値です。購入前にパッケージの表示をご確認ください。',
    footerNav_(),
    '</footer>',
    '</div>',
    productLd,
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
}

/**
 * トップページ（1杯あたりの安い順）のHTMLを組み立てる。
 *
 * @param {Array} entries [{product, price, unitValue, href}] を安い順に並べたもの
 * @param {Object} ctx {updatedLabel, powderCount, rtdCount}
 */
function buildIndexHtml_(entries, ctx) {
  const powder = entries.filter(function (e) { return e.product.form !== 'RTD'; });
  const rtd = entries.filter(function (e) { return e.product.form === 'RTD'; });

  function section(title, note, list, unitLabel, formKey) {
    if (!list.length) return '';

    const rows = list.map(function (e, index) {
      const p = e.product;
      const size = p.capacity ? comma_(p.capacity) + (p.form === 'RTD' ? 'ml' : 'g') : '';
      const name = [p.brand, p.series, p.flavor].filter(Boolean).join(' ');

      // 絞り込みと並べ替えに使う値を行に持たせる。
      // 並べ替えはブラウザ側でやるので、生成し直さなくても順番を変えられる。
      const marks = ' data-brand="' + esc_(p.brandId || '') + '"' +
        ' data-method="' + esc_(methodSlug_(p.method)) + '"' +
        ' data-price="' + e.unitValue + '"' +
        ' data-protein="' + (p.proteinPerServing || 0) + '"';

      return [
        '<div class="lrow' + (index === 0 ? ' first' : '') + '"' + marks + '>',
        '<div class="rank n"><span class="rk-num">' + (index + 1) + '</span>' + rankArrowHtml_(e.rankChange) + '</div>',
        pkgBlock_(p, 200, e.href),
        '<div>',
        '<div class="rname"><a href="' + esc_(e.href) + '">' + esc_(name) + '</a></div>',
        '<div class="rbrand">' + esc_([p.maker, size, p.method].filter(Boolean).join(' ／ ')) + '</div>',
        p.experience ? '<div class="rbrand" style="color:#1A3FCC">飲んでみた記録あり</div>' : '',
        '<div class="pl"><div>',
        '<div class="cup"><span class="v n">' + e.unitValue + '</span><span class="u">' + unitLabel + '</span></div>',
        (p.form === 'RTD' && p.proteinPerServing)
          ? '<div class="tot">タンパク質 <b>' + p.proteinPerServing + '</b>g／本'
            + (e.per20g ? '　パウダー換算 1杯 <b>' + Math.round(e.per20g) + '</b>円' : '') + '</div>'
          : (e.price ? '<div class="tot">楽天市場 <b>' + comma_(e.price) + '</b>円</div>' : ''),
        '</div><a class="btn" href="' + esc_(e.href) + '">くわしく</a></div>',
        '</div></div>'
      ].filter(Boolean).join('\n');
    }).join('\n');

    // ドリンクだけ並べ替えを出す。
    // 1本を買い切るので「1本で何g摂れるか」が選ぶ基準になりうるため。
    // パウダーは1食分の量を自分で決められるので、この軸は意味を持たない。
    const head = (formKey === 'rtd')
      ? '<div class="sortb">' +
        '<a class="sb on" href="#" data-sort="price">1本あたりの安い順</a>' +
        '<a class="sb" href="#" data-sort="protein">タンパク質が多い順</a>' +
        '</div>'
      : '<span>' + esc_(note) + '</span>';

    return [
      '<section data-form="' + esc_(formKey) + '">',
      '<div class="sh"><h2>' + esc_(title) + '</h2>' + head + '</div>',
      rows,
      '</section>'
    ].join('\n');
  }

  // ItemList構造化データ。上位の商品を検索エンジンに一覧として伝える。
  const listLd = jsonLd_({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'プロテイン価格ランキング',
    itemListElement: entries.slice(0, 20).map(function (e, i) {
      return {
        '@type': 'ListItem',
        position: i + 1,
        url: 'https://proteinzukan.com' + e.href
      };
    })
  });

  return [
    htmlHead_(
      'プロテイン図鑑｜1杯あたりの値段で選ぶ',
      'プロテインをタンパク質20gあたりの価格で比べられます。価格は毎日更新しています。',
      'https://proteinzukan.com/'
    ),
    '<div class="ticker"><span>毎日6時に楽天市場から価格を自動取得・更新しています　　毎日6時に楽天市場から価格を自動取得・更新しています</span></div>',
    '<div class="wrap">',
    '<div class="hd">',
    '<div class="logo"><h1><a href="/">プロテイン図鑑</a></h1><small>毎日更新のプロテイン価格比較</small></div>',
    '<div class="upd"><b>' + esc_(ctx.updatedLabel) + '</b></div>',
    '</div>',

    '<p class="lead">同じタンパク質20gを摂るのに、いくらかかるか。' +
      '容量も1食分の量も違う商品を、同じものさしで並べています。</p>',
    '<p class="auto">価格は毎日6時に楽天市場から取得しています。</p>',

    // 読みものはトップに最新3本だけ出す。
    // 記事が増えるほど価格ランキングが下へ押し下げられ、
    // このサイトの主役が埋もれてしまうため、残りは一覧ページへ送る。
    (ctx.articles && ctx.articles.length) ? [
      '<section class="reads">',
      '<div class="sh"><h2>読みもの</h2><span>' + ctx.articles.length + '本</span></div>',
      ctx.articles.slice(0, INDEX_ARTICLE_COUNT).map(function (a) {
        return '<a class="read" href="' + esc_(a.href) + '">' +
          '<div class="rtx">' +
          '<div class="rt2">' + esc_(a.title) + '</div>' +
          (a.description ? '<div class="rd">' + esc_(a.description) + '</div>' : '') +
          '</div>' +
          '<span class="rgo">読む</span>' +
          '</a>';
      }).join('\n'),
      ctx.articles.length > INDEX_ARTICLE_COUNT
        ? '<a class="more" href="/articles/">読みものをすべて見る（' + ctx.articles.length + '本）</a>'
        : '',
      '</section>'
    ].filter(Boolean).join('\n') : '',

    // ランキングの前に絞り込みの入口を置く。
    // ブランド名や製法で探しに来る人の受け皿になり、
    // 内部リンクも増えるので、検索から拾われる入口が広がる。
    ((ctx.brands && ctx.brands.length) || (ctx.methods && ctx.methods.length)) ? [
      '<section>',
      '<div class="sh"><h2>ブランドから探す</h2><span>押すと下の一覧が絞り込まれます</span></div>',
      (ctx.brands && ctx.brands.length) ? renderChips_(ctx.brands, 'brand', entries.length) : '',
      (ctx.methods && ctx.methods.length) ? '<div class="chiplab">製法から探す</div>' : '',
      (ctx.methods && ctx.methods.length) ? renderChips_(ctx.methods, 'method') : '',
      '</section>'
    ].filter(Boolean).join('\n') : '',

    section('パウダー', 'タンパク質20gあたりの安い順', powder, '円/杯', 'powder'),
    section('ドリンク', '1本あたりの安い順', rtd, '円/本', 'rtd'),

    '<footer>',
    '価格は楽天市場のAPIから毎日6時に取得しています。表示時点で在庫や価格が変わっている場合があります。<br>',
    '成分値はメーカー公表値です。購入前にパッケージの表示をご確認ください。<br>',
    '当サイトはアフィリエイトプログラムを利用しています。',
    footerNav_(),
    '</footer>',
    '</div>',
    listLd,
    indexFilterScript_(),
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
}

/**
 * 読みもの一覧ページ（/articles/）のHTMLを組み立てる。
 *
 * トップページには最新数本しか出さないので、
 * 過去の記事にたどり着ける場所をここに用意する。
 *
 * @param {Array} articles [{title, description, href}] 新しい順
 * @param {Object} ctx {updatedLabel}
 */
function buildArticlesIndexHtml_(articles, ctx) {
  const list = articles || [];

  const cards = list.map(function (a) {
    return '<a class="read" href="' + esc_(a.href) + '">' +
      '<div class="rtx">' +
      '<div class="rt2">' + esc_(a.title) + '</div>' +
      (a.description ? '<div class="rd">' + esc_(a.description) + '</div>' : '') +
      '</div>' +
      '<span class="rgo">読む</span>' +
      '</a>';
  }).join('\n');

  return [
    htmlHead_(
      '読みもの一覧｜プロテイン図鑑',
      'プロテインの容量・味・買い方について、実際に使った記録をまとめています。',
      'https://proteinzukan.com/articles/'
    ),
    '<div class="wrap">',
    '<div class="hd">',
    '<div class="logo"><a href="/">プロテイン図鑑</a><small>毎日更新のプロテイン価格比較</small></div>',
    '<div class="upd"><b>' + esc_(ctx.updatedLabel) + '</b></div>',
    '</div>',
    '<div class="crumb"><a href="/">トップ</a> ／ 読みもの</div>',
    '<h1 style="font-size:22px;font-weight:900;line-height:1.4">読みもの一覧</h1>',

    '<section class="reads" style="margin-top:6px">',
    '<div class="sh"><h2>読みもの</h2><span>' + list.length + '本</span></div>',
    cards || '<p class="nodata">記事はまだありません。</p>',
    '</section>',

    '<a class="more" href="/">価格の一覧に戻る</a>',

    '<footer>',
    '記事中の価格は執筆時点のものです。各商品ページの価格は毎日6時に更新しています。<br>',
    '成分値はメーカー公表値です。購入前にパッケージの表示をご確認ください。<br>',
    '当サイトはアフィリエイトプログラムを利用しています。',
    footerNav_(),
    '</footer>',
    '</div>',
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
}

/**
 * フッターに出す共通リンク。
 * 運営者情報とお問い合わせ先は全ページから辿れるようにしておく。
 * ASPの審査でも見られる部分なので、埋もれさせない。
 */
function footerNav_() {
  return [
    '<nav class="fnav">',
    '<a href="/">トップ</a>',
    '<a href="/articles/">読みもの</a>',
    '<a href="/about/">このサイトについて</a>',
    '<a href="/about-zukan/">中の人について</a>',
    '<a href="/privacy/">プライバシーポリシー</a>',
    '<a href="' + esc_(SITE.CONTACT_URL) + '" target="_blank" rel="noopener">お問い合わせ</a>',
    '</nav>'
  ].join('');
}

/**
 * 「このサイトについて」（/about/）のHTMLを組み立てる。
 *
 * 詳しい経緯は記事のほうに書いてあるので、
 * ここは何をしているサイトかを短く示すだけにする。
 */
function buildAboutHtml_(ctx) {
  return [
    htmlHead_(
      'このサイトについて｜プロテイン図鑑',
      'プロテイン図鑑の運営者情報と、価格の集め方・記事の書き方についての方針です。',
      'https://proteinzukan.com/about/'
    ),
    '<div class="wrap">',
    '<div class="hd">',
    '<div class="logo"><a href="/">プロテイン図鑑</a><small>毎日更新のプロテイン価格比較</small></div>',
    '</div>',
    '<div class="crumb"><a href="/">トップ</a> ／ このサイトについて</div>',

    '<article class="art">',
    '<h1>このサイトについて</h1>',
    '<div class="meta">プロテイン図鑑の運営方針</div>',

    '<p>プロテインは、容量も1食分の量も、含まれるタンパク質の量も商品ごとに違います。袋の値段だけを並べても比べられません。</p>',
    '<p>このサイトは、すべての商品を<strong>タンパク質20gあたりの価格</strong>に換算して並べています。同じものさしに乗せることで、容量の違う商品どうしでも比べられるようにしています。</p>',

    '<h2>運営者</h2>',
    '<p>図鑑の中の人</p>',
    '<p>プロテインを何年か飲んでいる個人が運営しています。栄養やトレーニングの専門家ではありません。書いているのは、自分が買って飲んだ範囲のことだけです。</p>',

    '<h2>価格について</h2>',
    '<p>価格は楽天市場のAPIから毎日6時に取得しています。表示時点で在庫や価格が変わっている場合があります。</p>',
    '<p>楽天の価格を載せているのは毎日自動で取得できるためで、<strong>最安値を保証するものではありません。</strong>公式サイトのほうが安いこともあります。</p>',
    '<p>成分値はメーカーの公表値です。購入前にパッケージの表示をご確認ください。</p>',

    '<h2>記事について</h2>',
    '<ul>',
    '<li>体験を書くのは、実際に使った商品だけにしています</li>',
    '<li>記事本文に価格は書きません。商品カードは毎日最新の価格に描き直されます</li>',
    '<li>飲めばどうなる、といった効果の話は書きません</li>',
    '</ul>',
    '<p>作った経緯や、これまで飲んできたものについては<a href="/about-zukan/">こちらの記事</a>に書いています。</p>',

    '<h2>広告について</h2>',
    '<p>当サイトはアフィリエイトプログラムを利用しており、商品ページのリンクから収益を得る場合があります。ただし、順位や掲載内容は報酬額によって変えていません。並び順は価格から機械的に決まります。</p>',

    '<h2>お問い合わせ</h2>',
    '<p>掲載内容の誤りのご指摘や、掲載商品のご要望は<a href="' + esc_(SITE.CONTACT_URL) + '" target="_blank" rel="noopener">お問い合わせフォーム</a>からお願いします。</p>',
    '<p>個人で運営しているため、すべてのお問い合わせに返信できるとは限りません。</p>',
    '</article>',

    '<footer>',
    '価格は楽天市場のAPIから毎日6時に取得しています。<br>',
    '成分値はメーカー公表値です。購入前にパッケージの表示をご確認ください。<br>',
    '当サイトはアフィリエイトプログラムを利用しています。',
    footerNav_(),
    '</footer>',
    '</div>',
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
}

/**
 * プライバシーポリシー（/privacy/）のHTMLを組み立てる。
 *
 * アクセス解析とお問い合わせフォームで扱う情報について書く。
 * 使っているものが増えたら、ここに足すこと。
 */
function buildPrivacyHtml_(ctx) {
  return [
    htmlHead_(
      'プライバシーポリシー｜プロテイン図鑑',
      'プロテイン図鑑におけるアクセス解析、お問い合わせ情報、広告の取り扱いについて。',
      'https://proteinzukan.com/privacy/'
    ),
    '<div class="wrap">',
    '<div class="hd">',
    '<div class="logo"><a href="/">プロテイン図鑑</a><small>毎日更新のプロテイン価格比較</small></div>',
    '</div>',
    '<div class="crumb"><a href="/">トップ</a> ／ プライバシーポリシー</div>',

    '<article class="art">',
    '<h1>プライバシーポリシー</h1>',
    '<div class="meta">プロテイン図鑑（https://proteinzukan.com/）</div>',

    '<h2>アクセス解析について</h2>',
    '<p>当サイトでは、サイトの利用状況を把握するためにGoogleアナリティクスを使用しています。Googleアナリティクスはトラフィックデータの収集のためにCookieを使用します。</p>',
    '<p>収集されるのは閲覧されたページや滞在時間などの情報で、個人を特定するものではありません。この機能はブラウザの設定でCookieを無効にすることで収集を拒否できます。</p>',
    '<p>Googleアナリティクスの利用規約については<a href="https://marketingplatform.google.com/about/analytics/terms/jp/" target="_blank" rel="noopener">こちら</a>、Googleのプライバシーポリシーについては<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">こちら</a>をご確認ください。</p>',

    '<h2>お問い合わせでお預かりする情報</h2>',
    '<p>お問い合わせフォーム（Googleフォーム）では、お名前とメールアドレス、お問い合わせ内容をお預かりします。</p>',
    '<p>これらの情報は、お問い合わせへの対応にのみ使用します。ご本人の同意なく第三者に提供することはありません。ただし、法令に基づく開示請求があった場合を除きます。</p>',

    '<h2>広告について</h2>',
    '<p>当サイトは第三者配信のアフィリエイトプログラムに参加しており、商品を紹介する際にアフィリエイトリンクを使用する場合があります。</p>',
    '<p>これらのリンクを経由して商品が購入された場合、当サイトが報酬を受け取ることがあります。報酬の有無や金額によって、掲載順位や記載内容を変えることはありません。</p>',
    '<p>広告配信事業者がCookieを使用して、利用者の当サイトや他サイトへのアクセス情報をもとに広告を表示する場合があります。</p>',

    '<h2>掲載内容について</h2>',
    '<p>価格は楽天市場のAPIから取得した情報を掲載しています。表示時点で在庫や価格が変わっている場合があります。</p>',
    '<p>成分値はメーカーの公表値です。掲載内容の正確性には努めていますが、その完全性を保証するものではありません。当サイトの情報を利用したことで生じた損害について、責任を負いかねます。購入の判断は各販売店の情報をご確認のうえ、ご自身でお願いします。</p>',

    '<h2>免責事項</h2>',
    '<p>当サイトは栄養や健康に関する助言を行うものではありません。体調や食事に関する判断は、必要に応じて専門家にご相談ください。</p>',

    '<h2>お問い合わせ</h2>',
    '<p>本ポリシーに関するお問い合わせは<a href="' + esc_(SITE.CONTACT_URL) + '" target="_blank" rel="noopener">お問い合わせフォーム</a>からお願いします。</p>',

    '<hr>',
    '<p class="cap">運営者: 図鑑の中の人</p>',
    '</article>',

    '<footer>',
    '価格は楽天市場のAPIから毎日6時に取得しています。<br>',
    '成分値はメーカー公表値です。購入前にパッケージの表示をご確認ください。<br>',
    '当サイトはアフィリエイトプログラムを利用しています。',
    footerNav_(),
    '</footer>',
    '</div>',
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
}

/**
 * PRカード（アフィリエイトリンク付き）を描く。
 *
 * 楽天の商品カードは価格を自動取得しているが、こちらは手で置くリンクになる。
 * 見た目をはっきり分け、「PR」の表示とリンクの rel="sponsored" を必ず付ける。
 * 景品表示法のステルスマーケティング規制で、広告であることの明示が要るため。
 *
 * @param {Object} c {name, url, note, image} image は省略可（無ければ画像なしで出す）
 */
function renderPrCard_(c) {
  const url = String(c.url || '').trim();

  if (!/^https:\/\//.test(url)) {
    return '<p class="nodata">リンクが正しく設定されていないため、この紹介は表示していません。</p>';
  }

  const image = String(c.image || '').trim();

  // カード全体をリンクにする。ボタンは <a> の入れ子を避けるため <span> にする
  // （実際に遷移する要素はカード自体の <a> 1つだけにする）。
  return [
    '<a class="prc' + (image ? ' has-img' : '') + '" href="' + esc_(url) + '" target="_blank" rel="sponsored nofollow noopener"' +
      ' onclick="gtag(\'event\',\'affiliate_click\',{shop:\'pr\',item_id:\'' + esc_(c.name) + '\'})">',
    image ? '<div class="pimg"><img src="' + esc_(image) + '" alt="' + esc_(c.name) + '" loading="lazy" decoding="async"></div>' : '',
    '<div class="pbody">',
    '<div class="prtag">PR</div>',
    '<div class="pname">' + esc_(c.name) + '</div>',
    c.note ? '<div class="pnote">' + esc_(c.note) + '</div>' : '',
    '<div class="pfoot">',
    '<span class="btn acc">公式サイトで見る</span>',
    '</div>',
    '</div>',
    '</a>'
  ].filter(Boolean).join('\n');
}

/**
 * 商品を1行ぶん描く（順位つきの一覧行）。
 * トップページ・ブランド別・製法別で同じ見た目を使う。
 */
function renderRankRow_(e, index, unitLabel) {
  const p = e.product;
  const size = p.capacity ? comma_(p.capacity) + (p.form === 'RTD' ? 'ml' : 'g') : '';
  const name = [p.brand, p.series, p.flavor].filter(Boolean).join(' ');

  return [
    '<div class="lrow' + (index === 0 ? ' first' : '') + '">',
    '<div class="rank n">' + (index + 1) + '</div>',
    pkgBlock_(p, 200, e.href),
    '<div>',
    '<div class="rname"><a href="' + esc_(e.href) + '">' + esc_(name) + '</a></div>',
    '<div class="rbrand">' + esc_([p.maker, size, p.method].filter(Boolean).join(' ／ ')) + '</div>',
    p.experience ? '<div class="rbrand" style="color:#1A3FCC">飲んでみた記録あり</div>' : '',
    '<div class="pl"><div>',
    '<div class="cup"><span class="v n">' + e.unitValue + '</span><span class="u">' + unitLabel + '</span></div>',
    (p.form === 'RTD' && p.proteinPerServing)
      ? '<div class="tot">タンパク質 <b>' + p.proteinPerServing + '</b>g／本'
        + (e.per20g ? '　パウダー換算 1杯 <b>' + Math.round(e.per20g) + '</b>円' : '') + '</div>'
      : (e.price ? '<div class="tot">楽天市場 <b>' + comma_(e.price) + '</b>円</div>' : ''),
    '</div><a class="btn" href="' + esc_(e.href) + '">くわしく</a></div>',
    '</div></div>'
  ].filter(Boolean).join('\n');
}

/**
 * パウダーとドリンクに分けて一覧を描く。
 * 絞り込みページ（ブランド別・製法別）で使う。
 * 形態が片方しかなければ、そちらだけを出す。
 */
function renderFormSections_(entries) {
  const powder = entries.filter(function (e) { return e.product.form !== 'RTD'; });
  const rtd = entries.filter(function (e) { return e.product.form === 'RTD'; });

  function block(title, note, list, unitLabel) {
    if (!list.length) return '';

    return [
      '<section>',
      '<div class="sh"><h2>' + esc_(title) + '</h2><span>' + esc_(note) + '</span></div>',
      list.map(function (e, i) { return renderRankRow_(e, i, unitLabel); }).join('\n'),
      '</section>'
    ].join('\n');
  }

  return [
    block('パウダー', 'タンパク質20gあたりの安い順', powder, '円/杯'),
    block('ドリンク', '1本あたりの安い順', rtd, '円/本')
  ].filter(Boolean).join('\n');
}

/**
 * 絞り込みリンクの並び（トップページ用）。
 *
 * リンク先は実在するブランド別・製法別ページにしてある。
 * 検索エンジンにはそちらを辿ってもらい、
 * 実際にクリックした人にはページ遷移させず、その場で一覧を絞り込む。
 * JavaScriptが動かない環境ではリンクとして機能する。
 *
 * @param {Array} items [{name, href, count, key}]
 * @param {string} kind 'brand' または 'method'
 */
function renderChips_(items, kind, resetCount) {
  // 先頭に「すべて」を置く。
  // 絞り込みを解除する手段が「もう一度同じチップを押す」しかないと、
  // 解除できることに気づけず、読み込み直すことになるため。
  const reset = (resetCount === undefined || resetCount === null) ? '' :
    '<a class="chip on" href="/" data-filter="all" data-value="">すべて<em>' +
    resetCount + '</em></a>';

  return '<div class="chips">' + reset + (items || []).map(function (c) {
    return '<a class="chip" href="' + esc_(c.href) + '"' +
      ' data-filter="' + esc_(kind) + '" data-value="' + esc_(c.key) + '">' +
      esc_(c.name) + '<em>' + c.count + '</em></a>';
  }).join('') + '</div>';
}

/**
 * トップページの絞り込みを動かすスクリプト。
 *
 * 行を消さずに display で出し分け、見えている行だけ番号を振り直す。
 * 商品が1件も残らない区画は見出しごと隠す。
 */
function indexFilterScript_() {
  return [
    '<script>',
    '(function(){',
    'var chips=[].slice.call(document.querySelectorAll(".chip[data-filter]"));',
    'var sorts=[].slice.call(document.querySelectorAll(".sb[data-sort]"));',
    'var secs=[].slice.call(document.querySelectorAll("section[data-form]"));',
    'if(!secs.length)return;',
    'var all=null;',
    'chips.forEach(function(c){if(c.getAttribute("data-filter")==="all")all=c;});',
    'var fk="all",fv="",sm="price";',
    'function num(el,name){return parseFloat(el.getAttribute(name))||0;}',
    'function render(){',
    'secs.forEach(function(s){',
    'var rows=[].slice.call(s.querySelectorAll(".lrow"));',
    'if(s.getAttribute("data-form")==="rtd"){',
    'rows.sort(function(a,b){',
    'if(sm==="protein"){',
    'var d=num(b,"data-protein")-num(a,"data-protein");',
    'if(d)return d;',
    '}',
    'return num(a,"data-price")-num(b,"data-price");',
    '});',
    'rows.forEach(function(r){s.appendChild(r);});',
    '}',
    // 順位の矢印は「前回の全体順位」に対する変化なので、絞り込みや
    // 並べ替えで表示順が変わっているときは、番号と矢印の意味がずれる。
    // 既定の並び（絞り込みなし・価格順）のときだけ矢印を出す。
    'var showArrow=(fk==="all"&&sm==="price");',
    'var vis=0;',
    'rows.forEach(function(r){',
    'var ok=(fk==="all")||(r.getAttribute("data-"+fk)===fv);',
    'r.style.display=ok?"":"none";',
    'if(ok){vis++;',
    'var rk=r.querySelector(".rk-num");if(rk)rk.textContent=vis;',
    'var arrow=r.querySelector(".rk-arrow");if(arrow)arrow.style.display=showArrow?"":"none";',
    'r.className=(vis===1)?"lrow first":"lrow";}',
    '});',
    's.style.display=vis?"":"none";',
    '});',
    '}',
    'function mark(list,c){list.forEach(function(x){x.classList.remove("on");});if(c)c.classList.add("on");}',
    'chips.forEach(function(c){',
    'c.addEventListener("click",function(ev){',
    'ev.preventDefault();',
    'var off=(c!==all)&&c.classList.contains("on");',
    'if(c===all||off){fk="all";fv="";mark(chips,all);}',
    'else{fk=c.getAttribute("data-filter");fv=c.getAttribute("data-value");mark(chips,c);}',
    'render();',
    '});',
    '});',
    'sorts.forEach(function(b){',
    'b.addEventListener("click",function(ev){',
    'ev.preventDefault();',
    'sm=b.getAttribute("data-sort");',
    'mark(sorts,b);',
    'render();',
    '});',
    '});',
    '})();',
    '</script>'
  ].join('\n');
}

/**
 * ブランド別ページ（/brands/<ブランドID>/）のHTMLを組み立てる。
 *
 * 「ザバス 値段」のように、ブランド名で探す人の受け皿になる。
 * 中身はマスタと価格ログから自動で作られるので、書き足すものはない。
 *
 * @param {Object} brand {name, maker, slug}
 * @param {Array} entries 安い順に並べた商品
 * @param {Object} ctx {updatedLabel}
 */
function buildBrandHtml_(brand, entries, ctx) {
  const title = brand.name + 'のプロテイン価格一覧';

  return [
    htmlHead_(
      title + '｜プロテイン図鑑',
      brand.name + 'のプロテインを、タンパク質20gあたりの価格で並べています。価格は毎日更新。',
      'https://proteinzukan.com/brands/' + brand.slug + '/'
    ),
    '<div class="wrap">',
    '<div class="hd">',
    '<div class="logo"><a href="/">プロテイン図鑑</a><small>毎日更新のプロテイン価格比較</small></div>',
    '<div class="upd"><b>' + esc_(ctx.updatedLabel) + '</b></div>',
    '</div>',
    '<div class="crumb"><a href="/">トップ</a> ／ ブランド ／ ' + esc_(brand.name) + '</div>',

    '<h1 style="font-size:22px;font-weight:900;line-height:1.4">' + esc_(title) + '</h1>',
    '<p class="lead">' + esc_(brand.name) + 'の商品を、タンパク質20gを摂るのにいくらかかるかで並べています。' +
      '容量や1食分の量が違っても、同じものさしで比べられます。</p>',
    '<p class="auto">価格は毎日6時に楽天市場から取得しています。</p>',

    renderFormSections_(entries),

    '<a class="more" href="/">すべての商品を見る</a>',

    '<footer>',
    '価格は楽天市場のAPIから毎日6時に取得しています。表示時点で在庫や価格が変わっている場合があります。<br>',
    '成分値はメーカー公表値です。購入前にパッケージの表示をご確認ください。<br>',
    '当サイトはアフィリエイトプログラムを利用しています。',
    footerNav_(),
    '</footer>',
    '</div>',
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
}

/**
 * 製法別ページ（/methods/<スラッグ>/）のHTMLを組み立てる。
 *
 * WPCとWPIの違いを知った人が、次に「じゃあWPIで安いのは」と探すときの受け皿。
 *
 * @param {Object} method {name, slug}
 * @param {Array} entries 安い順に並べた商品
 * @param {Object} ctx {updatedLabel}
 */
function buildMethodHtml_(method, entries, ctx) {
  const title = method.name + 'のプロテイン価格一覧';

  return [
    htmlHead_(
      title + '｜プロテイン図鑑',
      method.name + 'のプロテインを、タンパク質20gあたりの価格で並べています。価格は毎日更新。',
      'https://proteinzukan.com/methods/' + method.slug + '/'
    ),
    '<div class="wrap">',
    '<div class="hd">',
    '<div class="logo"><a href="/">プロテイン図鑑</a><small>毎日更新のプロテイン価格比較</small></div>',
    '<div class="upd"><b>' + esc_(ctx.updatedLabel) + '</b></div>',
    '</div>',
    '<div class="crumb"><a href="/">トップ</a> ／ 製法 ／ ' + esc_(method.name) + '</div>',

    '<h1 style="font-size:22px;font-weight:900;line-height:1.4">' + esc_(title) + '</h1>',
    '<p class="lead">製法が' + esc_(method.name) + 'の商品を、タンパク質20gあたりの価格で並べています。</p>',
    '<p class="auto">価格は毎日6時に楽天市場から取得しています。</p>',

    renderFormSections_(entries),

    '<a class="more" href="/">すべての商品を見る</a>',

    '<footer>',
    '価格は楽天市場のAPIから毎日6時に取得しています。表示時点で在庫や価格が変わっている場合があります。<br>',
    '成分値はメーカー公表値です。購入前にパッケージの表示をご確認ください。<br>',
    '当サイトはアフィリエイトプログラムを利用しています。',
    footerNav_(),
    '</footer>',
    '</div>',
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
}
