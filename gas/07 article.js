/**
 * 07_Article.gs
 * 記事を書いて公開するための処理。
 *
 * 原稿は「記事」シートに置く。スマホからでも書けるようにするため、
 * ファイルではなくスプレッドシートを原稿の置き場にしている。
 *
 * URL は https://proteinzukan.com/<記事ID>/ になる。
 *
 * 【本文に書ける埋め込み】
 *   {{item:exp-whey-milkchoco-3000}}   … 商品カードを1枚
 *   {{list:RTD}}                       … ドリンクを安い順に（最大6件）
 *   {{list:パウダー:3}}                … パウダーを3件だけ
 *   {{pr:商品名|https://...|一言}}     … PR表示付きのアフィリエイトリンク
 *
 * 埋め込みは生成のたびに最新の価格で描き直される。
 * 記事本文に価格を直接書くと古くなるが、埋め込みなら古くならない。
 *
 * 【PRカードについて】
 * {{pr:...}} だけは区切りが「|」になる。リンクに「:」が入るため。
 * 商品カードとは見た目を分け、「PR」の表示と rel="sponsored" を必ず付ける。
 * 実際に使っていない商品には貼らないこと。
 *
 * 【並び順】
 * 一覧に出すときは公開日の新しい順。同じ日付ならシートの下の行を新しいものとして扱う。
 * トップページには先頭の数本だけを出し、残りは /articles/ へ送る。
 *
 * 【使い方】
 * 1. setupArticleSheet()  … 「記事」シートを作る
 * 2. シートに原稿を書く（ステータスを「公開」にする）
 * 3. buildAllPages()      … 記事も一緒に生成される
 */

const ARTICLE = {
  SHEET_NAME: '記事',

  // {{list:...}} で出す既定の件数
  DEFAULT_LIST_COUNT: 5,

  // 一覧に出す件数の上限
  MAX_LIST_COUNT: 8
};

const ARTICLE_HEADERS = [
  '記事ID', 'タイトル', '説明（検索結果に出る文）', '公開日', '更新日', 'ステータス', '本文'
];

// ============================================================
// 公開関数
// ============================================================

/**
 * 記事シートを作る。既にあれば何もしない。
 */
function setupArticleSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(ARTICLE.SHEET_NAME);

  if (sheet) {
    Logger.log('シートは既にあります: ' + ARTICLE.SHEET_NAME);
    return 'シートは既にあります。';
  }

  sheet = spreadsheet.insertSheet(ARTICLE.SHEET_NAME);
  sheet.getRange(1, 1, 1, ARTICLE_HEADERS.length).setValues([ARTICLE_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 320);
  sheet.setColumnWidth(7, 640);

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['公開', '下書き'], true)
    .build();
  sheet.getRange(2, 6, 200, 1).setDataValidation(rule);

  Logger.log('記事シートを作りました。');
  return '記事シートを作りました。A列に記事ID（URLになる半角英数字）、G列に本文を書いてください。';
}

/**
 * 記事ページを生成する。
 * buildAllPages から呼ばれる。単体でも実行できる。
 *
 * @return {Array} [{path, html}] 生成したページ
 */
function buildArticlePages_(entriesById) {
  const articles = readArticles_();
  const pages = [];

  articles.forEach(function (article) {
    const bodyHtml = renderArticleBody_(article.body, entriesById);
    pages.push({
      path: article.slug + '/index.html',
      html: buildArticleHtml_(article, bodyHtml)
    });
  });

  return pages;
}

/**
 * 記事の一覧（トップページと /articles/ に出す用）。
 * 公開日の新しい順に並べる。
 */
function listArticles_() {
  return sortArticlesNewestFirst_(readArticles_()).map(function (a) {
    return {
      title: a.title,
      description: a.description,
      href: '/' + a.slug + '/'
    };
  });
}

/**
 * 新しい順に並べ替える。
 * 公開日が入っていない、または同じ日付のときは、
 * シートで下にある行のほうを新しいものとして扱う。
 */
function sortArticlesNewestFirst_(articles) {
  return articles.slice().sort(function (a, b) {
    const at = a.publishedAt ? a.publishedAt.getTime() : 0;
    const bt = b.publishedAt ? b.publishedAt.getTime() : 0;

    if (at !== bt) return bt - at;

    return b.order - a.order;
  });
}

/**
 * 記事だけを作り直す。文章を直したときの確認用。
 *
 * 注意: この関数はトップページと /articles/ を作り直さない。
 * 記事を増やしたときは buildAllPages を実行すること。
 */
function buildArticlesOnly() {
  const products = readMasterFull_();
  const history = readPriceHistory_();
  const entries = buildEntries_(products.filter(function (p) { return p.status === '公開'; }), history);

  const entriesById = {};
  entries.forEach(function (e) { entriesById[e.product.productId] = e; });

  const pages = buildArticlePages_(entriesById);

  if (pages.length === 0) {
    return 'ステータスが「公開」の記事がありません。';
  }

  const record = loadBuildRecord_();
  let uploaded = 0;

  pages.forEach(function (page) {
    putTextToGithub_(page.path, page.html);
    record[page.path] = md5_(page.html);
    uploaded++;
    Utilities.sleep(350);
  });

  saveBuildRecord_(record);

  const message = '記事を更新しました: ' + uploaded + '件\n' +
    '※ トップページと読みもの一覧は更新していません。記事を追加したときは buildAllPages を実行してください。\n' +
    pages.map(function (p) { return siteUrl_(p.path); }).join('\n');
  Logger.log(message);
  return message;
}

// ============================================================
// 読み込み
// ============================================================

function readArticles_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  const col = {};

  values[0].forEach(function (name, index) {
    const key = String(name).trim();
    if (key && col[key] === undefined) col[key] = index;
  });

  function text(row, name) {
    return col[name] === undefined ? '' : String(row[col[name]] || '').trim();
  }

  function dateLabel(row, name) {
    if (col[name] === undefined) return '';
    const value = row[col[name]];
    if (value instanceof Date) {
      return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy年M月d日');
    }
    return String(value || '').trim();
  }

  // 並べ替えに使うので、表示用の文字列とは別に日付そのものも持っておく
  function rawDate(row, name) {
    if (col[name] === undefined) return null;
    const value = row[col[name]];
    return value instanceof Date ? value : null;
  }

  const articles = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const slug = text(row, '記事ID');

    if (!slug) continue;
    if (text(row, 'ステータス') !== '公開') continue;

    articles.push({
      slug: slug,
      title: text(row, 'タイトル'),
      description: text(row, '説明（検索結果に出る文）'),
      publishedLabel: dateLabel(row, '公開日'),
      updatedLabel: dateLabel(row, '更新日'),
      publishedAt: rawDate(row, '公開日'),
      order: i,
      body: col['本文'] === undefined ? '' : String(row[col['本文']] || '')
    });
  }

  return articles;
}

// ============================================================
// 本文の変換
// ============================================================

/**
 * 本文（Markdown＋埋め込み記法）をHTMLにする。
 *
 * 埋め込みの結果は複数行のHTMLになるため、先にHTML化すると
 * Markdown変換が途中の行を本文として扱ってしまう。
 * そこで、埋め込みをいったん目印に置き換えてから変換し、
 * 変換が終わったあとで戻す。
 */
function renderArticleBody_(body, entriesById) {
  const byId = entriesById || {};

  // 一覧で使えるよう、形態ごとに安い順で並べておく
  const byForm = {};

  Object.keys(byId).forEach(function (id) {
    const e = byId[id];
    const form = e.product.form || 'その他';
    if (!byForm[form]) byForm[form] = [];
    byForm[form].push(e);
  });

  Object.keys(byForm).forEach(function (form) {
    byForm[form].sort(function (a, b) { return a.unitValue - b.unitValue; });
  });

  const blocks = [];

  const withTokens = String(body || '').replace(/\{\{(item|list|pr|img):([^}]+)\}\}/g, function (whole, kind, rest) {
    blocks.push(renderEmbed_(kind, rest, byId, byForm));
    return '\n\n' + embedToken_(blocks.length - 1) + '\n\n';
  });

  let html = markdownToHtml_(withTokens);

  blocks.forEach(function (block, index) {
    const token = embedToken_(index);
    // 目印が段落に包まれている場合と、そのまま残っている場合の両方を戻す
    html = html.split('<p>' + token + '</p>').join(block).split(token).join(block);
  });

  return html;
}

/** 埋め込みの目印。本文に現れない文字列にする。 */
function embedToken_(index) {
  return '@@PZ_EMBED_' + index + '@@';
}

/**
 * {{item:...}} または {{list:...}} 1つぶんのHTMLを作る。
 */
function renderEmbed_(kind, rest, byId, byForm) {
  // PRカードだけは区切りを「|」にする。
  // リンクに「https://」が含まれるので、「:」で分けられないため。
  // 4つ目（画像URL）は省略可。無ければ画像なしのカードになる。
  if (kind === 'pr') {
    const parts = String(rest).split('|').map(function (s) { return s.trim(); });

    return renderPrCard_({
      name: parts[0] || '',
      url: parts[1] || '',
      note: parts[2] || '',
      image: parts[3] || ''
    });
  }

  // 画像（スクリーンショット）。{{img:ファイル名|代替テキスト|幅|高さ|キャプション}}
  // ファイルは /assets/articles/ に置く。幅と高さは、読み込み中にレイアウトが
  // ずれないよう実寸を書く。キャプションは省略可。
  if (kind === 'img') {
    const parts = String(rest).split('|').map(function (s) { return s.trim(); });
    const file = parts[0] || '';
    const width = parseInt(parts[2], 10) || 0;
    const height = parseInt(parts[3], 10) || 0;

    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      return '<p class="nodata">画像のファイル名が正しくありません。</p>';
    }

    return [
      '<figure class="shot">',
      '<img src="/assets/articles/' + esc_(file) + '" alt="' + esc_(parts[1] || '') + '"' +
        (width && height ? ' width="' + width + '" height="' + height + '"' : '') +
        ' loading="lazy" decoding="async">',
      parts[4] ? '<figcaption>' + esc_(parts[4]) + '</figcaption>' : '',
      '</figure>'
    ].filter(Boolean).join('\n');
  }

  const args = String(rest).split(':').map(function (s) { return s.trim(); });

  if (kind === 'item') {
    const entry = byId[args[0]];

    if (!entry) {
      return '<p class="nodata">商品「' + esc_(args[0]) + '」は現在価格を取得できていないため表示していません。</p>';
    }

    return '<div class="embed">' + renderItemCard_(toCard_(entry)) + '</div>';
  }

  const form = args[0];
  const count = Math.min(
    ARTICLE.MAX_LIST_COUNT,
    Math.max(1, parseInt(args[1], 10) || ARTICLE.DEFAULT_LIST_COUNT)
  );
  const list = (byForm[form] || []).slice(0, count);

  if (list.length === 0) {
    return '<p class="nodata">「' + esc_(form) + '」に表示できる商品がありません。</p>';
  }

  const label = form === 'RTD' ? 'ドリンク' : form;

  return [
    '<div class="embed">',
    '<div class="ttl">' + esc_(label) + '　' + (form === 'RTD' ? '1本あたりの安い順' : 'タンパク質20gあたりの安い順') + '</div>',
    list.map(function (e) { return renderItemCard_(toCard_(e)); }).join('\n'),
    '</div>'
  ].join('\n');
}

/** entry を商品カード用の形に直す */
function toCard_(entry) {
  const p = entry.product;

  return {
    productId: p.productId,
    maker: p.maker,
    brand: p.brand,
    series: p.series,
    flavor: p.flavor,
    form: p.form,
    capacity: p.capacity,
    method: p.method,
    imageUrl: p.imageUrl,
    proteinPerServing: p.proteinPerServing,
    unitValue: entry.unitValue,
    per20g: entry.per20g,
    price: entry.price ? entry.price.price : '',
    href: entry.href
  };
}

/**
 * 記事に使う範囲だけのMarkdown変換。
 * 見出し、段落、強調、リンク、箇条書き、表、区切り線に対応する。
 * 既にHTMLになっている行（埋め込みの結果）はそのまま通す。
 */
function markdownToHtml_(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];

  let paragraph = [];
  let listBuffer = null;
  let tableBuffer = null;

  function flushParagraph() {
    if (paragraph.length) {
      out.push('<p>' + inline_(paragraph.join('<br>')) + '</p>');
      paragraph = [];
    }
  }

  function flushList() {
    if (listBuffer) {
      out.push('<ul>' + listBuffer.map(function (li) {
        return '<li>' + inline_(li) + '</li>';
      }).join('') + '</ul>');
      listBuffer = null;
    }
  }

  function flushTable() {
    if (!tableBuffer) return;

    const rows = tableBuffer.filter(function (r) {
      return !/^\s*\|?[\s:\-|]+\|?\s*$/.test(r);
    });

    const cells = rows.map(function (r) {
      return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) {
        return inline_(c.trim());
      });
    });

    if (cells.length) {
      const head = '<tr>' + cells[0].map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
      const body = cells.slice(1).map(function (row) {
        return '<tr>' + row.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
      }).join('');
      out.push('<table>' + head + body + '</table>');
    }

    tableBuffer = null;
  }

  function flushAll() {
    flushParagraph();
    flushList();
    flushTable();
  }

  lines.forEach(function (raw) {
    const line = raw.replace(/\s+$/, '');

    // 埋め込みなど、すでにHTMLになっている行はそのまま出す
    if (/^\s*<(div|p|table|section|ul|ol)/.test(line)) {
      flushAll();
      out.push(line);
      return;
    }

    if (line.trim() === '') {
      flushAll();
      return;
    }

    if (/^\|/.test(line.trim())) {
      flushParagraph();
      flushList();
      if (!tableBuffer) tableBuffer = [];
      tableBuffer.push(line.trim());
      return;
    }

    flushTable();

    if (/^###\s+/.test(line)) {
      flushAll();
      out.push('<h3>' + inline_(line.replace(/^###\s+/, '')) + '</h3>');
      return;
    }

    if (/^##\s+/.test(line)) {
      flushAll();
      out.push('<h2>' + inline_(line.replace(/^##\s+/, '')) + '</h2>');
      return;
    }

    if (/^#\s+/.test(line)) {
      // 記事タイトルは見出しとして別に出しているので、本文中の H1 は H2 に落とす
      flushAll();
      out.push('<h2>' + inline_(line.replace(/^#\s+/, '')) + '</h2>');
      return;
    }

    if (/^---+$/.test(line.trim())) {
      flushAll();
      out.push('<hr>');
      return;
    }

    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      if (!listBuffer) listBuffer = [];
      listBuffer.push(line.replace(/^[-*]\s+/, ''));
      return;
    }

    if (/^※/.test(line.trim())) {
      flushAll();
      out.push('<p class="cap">' + inline_(line.trim()) + '</p>');
      return;
    }

    flushList();
    paragraph.push(line.trim());
  });

  flushAll();

  return out.join('\n');
}

/** 行内の記法（強調・リンク）を処理する */
function inline_(text) {
  return escapeExceptTags_(String(text))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * HTMLエスケープ。ただし <br> だけは通す。
 * 本文に書かれた < > をそのまま出すと表示が壊れるため。
 */
function escapeExceptTags_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;br&gt;/g, '<br>')
    .replace(/"/g, '&quot;');
}

/**
 * 投稿用の一時関数。「wpi-ya-mizu-no-ryou」記事を「記事」シートに追加する。
 * 実行後はこの関数を消してよい。
 */
function addArticle_wpiYaMizuNoRyou() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);

  if (!sheet) {
    throw new Error('「記事」シートが見つかりません。先に setupArticleSheet() を実行してください。');
  }

  const body = [
    '筋トレを始めた当初、WPCのプロテインを飲むとお腹を下すことがよくあった。',
    '',
    '## WPIを勧められた',
    '',
    '知り合いのパーソナルトレーナーに相談したところ、「乳糖不耐症かもしれない」と言われ、乳糖の少ないWPIを勧められた。',
    '',
    '言われた通りWPIに変えて飲んでみた。**ただ、当時はあまり変わらなかった。**',
    '',
    '## 原因は、飲む水の量だったかもしれない',
    '',
    '粉の種類を変えても改善しなかったので、他に原因があるはずだと考えるようになった。',
    '',
    '振り返ると、当時は1回につき300mlくらいの水で飲んでいた。プロテインの量は変えていないが、試しに150〜200mlに減らしてみたところ、お腹を下すことが減った。',
    '',
    '## WPCに戻しても、下さなくなった',
    '',
    '決め手になったのは、その後の話だ。**水の量を150〜200mlに保ったまま、WPCに戻してみた。**',
    '',
    '今もエクスプロージョンのWPCを、150〜200mlで飲んでいる。**それ以来、下すことはなくなった。**',
    '',
    '副産物もあった。**水が少ないぶん味が濃くなって、単純に美味い。** お腹の調子だけでなく、味の面でもこちらのほうが良かった。',
    '',
    '乳糖の少ないWPIに変えても症状が変わらず、粉の種類を戻しても水の量さえ変えなければ症状が出ていない。少なくとも自分の場合は、乳糖よりも一度に飲む水分量のほうが関係していたようだ。',
    '',
    '## これは個人の記録であって、医学的な助言ではない',
    '',
    '乳糖不耐症の検査を受けたわけではないし、他に体調や条件が変わっていた可能性もある。**自分の場合はこうだった、という記録以上のものではない。** お腹の不調が続く場合は、自己判断で済ませず医師に相談したほうがいい。',
    '',
    '## 人に勧めるなら、今はエクスプロージョン',
    '',
    '余談だが、色々な商品を飲んできて、今人に勧めるなら価格と味のバランスでエクスプロージョンを選ぶ。レイズやDNSのカフェオレ味も評判がよく、実際に美味しいと思うが、値段は高め。このあたりは別の記事にも書いた通りだ。',
    '',
    '## まとめ',
    '',
    '- WPCでお腹を下していたが、WPIに変えても当時は改善しなかった',
    '- 原因は乳糖ではなく、1回に飲む水の量（300ml→150〜200ml）だったらしい',
    '- 水の量を保ったままWPCに戻しても、下さなくなった。味も濃くなって美味い',
    '- これは個人の記録で、医学的な助言ではない'
  ].join('\n');

  sheet.appendRow([
    'wpi-ya-mizu-no-ryou',
    'お腹を下していた原因は、プロテインの種類ではなく水の量だった',
    '筋トレを始めた頃、WPCでよくお腹を下していた。トレーナーにWPIを勧められて試したが変わらず、実際の原因は飲む水の量だった、という記録。',
    new Date(2026, 8, 16),
    new Date(2026, 8, 16),
    '公開',
    body
  ]);

  Logger.log('記事を追加しました: wpi-ya-mizu-no-ryou。次に buildAllPages() を実行してください。');
  return '記事を追加しました。次に buildAllPages() を実行してください。';
}

/**
 * 投稿用の一時関数。「sale-wo-matanai」記事を「記事」シートに追加する。
 * 手で貼り付けるとGoogleスプレッドシート側で改行が崩れることがあるため、
 * コードから直接1行追加する。実行後はこの関数を消してよい。
 */
function addArticle_saleWoMatanai() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);

  if (!sheet) {
    throw new Error('「記事」シートが見つかりません。先に setupArticleSheet() を実行してください。');
  }

  const body = [
    'プロテインの価格比較サイトをやっていると、セール情報にも詳しいと思われることがある。',
    '',
    '正直に言うと、**セールを待って買った記憶がほとんどない。**',
    '',
    '## 消費されたタイミングで買っている',
    '',
    '理由は単純で、セールの周期より先に、手元のプロテインが切れるからだ。',
    '',
    'パウダーは1袋を数ヶ月かけて飲む。切れそうになったら注文する。そのタイミングがたまたまセールと重なることはあるが、セールに合わせて早めに買ったり、逆に我慢して待ったりしたことはない。',
    '',
    '**待っている間に本当に切れたら困る。** 安く買えることより、切らさないことのほうが自分には優先度が高い。',
    '',
    '## ポイントで安くなったことはある',
    '',
    'セールとは別に、結果的に安く買えたことはある。理由はポイントだ。',
    '',
    '生活費のほとんどを楽天カードで払っていて、月にだいたい10万円ほどの決済がある。プロテインのために貯めているわけではなく、他の支払いのついでに溜まっているだけなのだが、そのポイントを使うと、1回の購入で1,000円くらい安くなることがある。',
    '',
    'これは楽天スーパーSALEやお買い物マラソンとは関係ない。**セールを狙った結果ではなく、カードを1枚にまとめているだけの副産物だ。**',
    '',
    '## 損した記憶も、得した記憶も特にない',
    '',
    'セールを逃して後悔したことも、たまたま当たってラッキーだったこともない。',
    '',
    '楽天スーパーSALEの存在は知っている。ただ、それに合わせて買い物のタイミングを変えたことは一度もない。',
    '',
    '## まとめ',
    '',
    '- セールの周期より先に、手元のプロテインが切れる。だから待たない',
    '- ポイントで安くなることはあるが、狙って貯めているわけではない',
    '- セールを逃して後悔した記憶も、得した記憶も特にない',
    '',
    'セール情報を求めてこのページに来た人には申し訳ないが、これが自分の実際の買い方だ。'
  ].join('\n');

  sheet.appendRow([
    'sale-wo-matanai',
    'セール情報サイトのようですが、セールを待って買ったことはありません',
    '楽天スーパーSALEは知っていますが、狙って買った記憶がありません。プロテインを買うタイミングと、ポイントで安くなった経験についての記録。',
    new Date(2026, 8, 7),
    new Date(2026, 8, 7),
    '公開',
    body
  ]);

  Logger.log('記事を追加しました: sale-wo-matanai。次に buildAllPages() を実行してください。');
  return '記事を追加しました。次に buildAllPages() を実行してください。';
}


/**
 * 一時関数。tsuzukanakatta記事の「1年ほど」を正確な「1年9か月ほど」に修正する。
 * 新しい保管記事で同じ転職の話を扱うにあたり、ユーザーに確認したところ
 * 正確な期間は1年9か月だったため、既存記事側も合わせる。
 * 実行後はこの関数を消してよい。
 */
function fixTsuzukanakattaDuration() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  const header = values[0];

  const idCol = header.indexOf('記事ID');
  const bodyCol = header.indexOf('本文');

  let targetRow = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]).trim() === 'tsuzukanakatta') {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error('記事が見つかりません: tsuzukanakatta');
  }

  let body = sheet.getRange(targetRow, bodyCol + 1).getValue();

  const replacements = [
    ['## 1年やめていた時期がある', '## 1年9か月ほどやめていた時期がある'],
    ['そのまま**1年ほどジムを休会した。**', 'そのまま**1年9か月ほどジムを休会した。**'],
    ['- 1年やめていた時期がある。理由は転職で、商品とは関係なかった', '- 1年9か月ほどやめていた時期がある。理由は転職で、商品とは関係なかった']
  ];

  const missing = [];
  replacements.forEach(function (pair) {
    if (body.indexOf(pair[0]) === -1) {
      missing.push(pair[0]);
    } else {
      body = body.split(pair[0]).join(pair[1]);
    }
  });

  if (missing.length > 0) {
    throw new Error('本文中に見つからない文字列があります:\n' + missing.join('\n'));
  }

  sheet.getRange(targetRow, bodyCol + 1).setValue(body);

  Logger.log('修正しました: tsuzukanakatta（1年ほど → 1年9か月ほど、3箇所）');
  return '修正しました。次に buildAllPages() を実行してください。';
}

/**
 * 投稿用の一時関数。「hokan-basho」記事を「記事」シートに追加する。
 * 実行後はこの関数を消してよい。
 */
function addArticle_hokanBasho() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);

  if (!sheet) {
    throw new Error('「記事」シートが見つかりません。先に setupArticleSheet() を実行してください。');
  }

  const body = [
    'プロテインを飲む生活を続けるうえで、地味に効いてくるのが保管場所だった。',
    '',
    '一時期、完全に手放したことがある。',
    '',
    '## 保管場所がなくて、処分した',
    '',
    '[転職でジムを1年9か月ほど休会していた時期がある](/tsuzukanakatta/)。',
    '',
    '離れている間、プロテインの使用頻度はほぼ0になった。置き場所を確保できないまま粉だけが残っている状態が続き、結局処分してしまった。',
    '',
    'もったいなかったとは思うが、当時は再開する見込みも立っていなかったので、**場所だけ取っている状態を続けるよりはと判断した。**',
    '',
    '## 今はニトリの洗えるレバーキャニスターを使っている',
    '',
    '筋トレを再開してからは、[洗えるレバーキャニスター（L・4,500mL）](https://www.nitori-net.jp/ec/product/8931117/)というニトリの容器に落ち着いている。透明の樹脂ケースで、いちばん大きいサイズを選んだ。',
    '',
    '良かった点は3つある。',
    '',
    '**透明なので残量が一目でわかる。** 袋のままだと減り具合が掴みにくいが、これなら補充のタイミングを逃さない。',
    '',
    '**しっかり密閉される。** レバー式の蓋で、湿気や匂い移りが気にならない。',
    '',
    '**洗いやすい。** 口が大きく開くので、袋からの移し替えも内部を洗うのも手間がかからない。',
    '',
    '## 3kgの袋はそのまま入りきらない',
    '',
    '注意点もある。**このキャニスターに3kgの袋はそのままでは入らない。**',
    '',
    '{{item:exp-whey-milkchoco-3000}}',
    '',
    'まとめ買いをする場合は、容器のサイズに合わせて購入量を調整するか、複数の容器に分けるなどの工夫が必要になる。',
    '',
    '## 見た目や置き場所を気にする人には向いている',
    '',
    'パッケージのまま棚に置くのが気にならない人は、袋のままでも困らないと思う。',
    '',
    'ただ、キッチンに置くものの見た目を揃えたい人や、保管場所をきちんと決めておきたい人には、このキャニスターはおすすめできる。',
    '',
    '## まとめ',
    '',
    '- 転職でジムを1年9か月ほど休会していた間、保管場所がなくプロテインを処分したことがある',
    '- 再開後はニトリの洗えるレバーキャニスター（L・4,500mL）を使っている',
    '- 透明で残量がわかりやすく、密閉性・洗いやすさも良い',
    '- 3kgの袋はそのままでは入らないので、購入量や容器の使い方を調整する必要がある'
  ].join('\n');

  sheet.appendRow([
    'hokan-basho',
    'プロテインを一度手放したのは、保管場所を決めていなかったせいだった',
    '転職でジムを1年9か月ほど離れていた間、保管場所がなくプロテインを処分した。今はニトリの洗えるキャニスターで解決している記録。',
    new Date(),
    new Date(),
    '公開',
    body
  ]);

  Logger.log('記事を追加しました: hokan-basho。次に buildAllPages() を実行してください。');
  return '記事を追加しました。次に buildAllPages() を実行してください。';
}


/**
 * doko-de-kau 記事に、スーパースポーツゼビオでDNSを買った実体験を
 * 具体的に書き足す。もともと「スポーツ用品の量販店」とだけ書いていた
 * 部分を実名にし、アクセストレード経由のPRリンクを追加する。
 * HMBプレミアムマッスルボディアは未使用のため、こちらは組み込まない
 * （実際に使っていない商品には貼らない、という記事の方針に従う）。
 */
function addZebioMentionToDokoDeKau() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  const header = values[0];

  function col(name) {
    const index = header.indexOf(name);
    if (index === -1) throw new Error('列が見つかりません: ' + name);
    return index;
  }

  let targetRow = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col('記事ID')]).trim() === 'doko-de-kau') {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error('doko-de-kau が見つかりませんでした。');
  }

  const bodyCol = col('本文');
  let body = String(sheet.getRange(targetRow, bodyCol + 1).getValue());

  const oldSentence = 'そういうときは、スポーツ用品の量販店やドンキホーテ、ドラッグストアで買ったことがある。';
  const newSentence = 'そういうときは、スポーツ用品の量販店やドンキホーテ、ドラッグストアで買ったことがある。DNSのホエイプロテインを、スーパースポーツゼビオの店舗で買ったのがそれだ。';

  if (body.indexOf(oldSentence) === -1) {
    throw new Error('置き換え対象の文が見つかりませんでした。本文が変わっている可能性があります。');
  }

  body = body.replace(oldSentence, newSentence);

  const anchor = 'その日のうちに手に入るかわりに、選べる幅は狭くなる。切らさないように買っておくのが一番だが、間に合わなかったときの選択肢としては覚えておいていい。';
  if (body.indexOf(anchor) === -1) {
    throw new Error('PR埋め込みの挿入位置が見つかりませんでした。');
  }

  const prEmbed = '{{pr:スーパースポーツゼビオ|https://h.accesstrade.net/sp/cc?rk=0100o9gh00zkd|プロテインだけでなく、スポーツ用品全般を扱う量販店。実際にDNSを買ったのもここ。店舗で受け取れるので、通販が間に合わないときの選択肢になる。}}';

  body = body.replace(anchor, anchor + '\n\n' + prEmbed);

  sheet.getRange(targetRow, bodyCol + 1).setValue(body);

  const message = 'doko-de-kau を更新しました。\n・スーパースポーツゼビオでDNSを買った話を具体化\n・PRリンクを追加\n\n次の手順: buildAllPages() を実行してサイトに反映。';
  Logger.log(message);
  return message;
}


/**
 * 新しい記事「プロテインが溶け残るのは、季節のせいではなく水道水の温度
 * だった」を追加する。ペットのため年中エアコン稼働で室温差がほぼ無い
 * こと、そのかわり水道水の温度が季節で変わり、冬だけ溶け残りやすい
 * こと、対策として冷水とぬるま湯・お湯を2段階で入れていること、
 * という実体験に基づく。
 */
function addArticle_tokenokori() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);

  if (!sheet) {
    throw new Error('「記事」シートが見つかりません。先に setupArticleSheet() を実行してください。');
  }

  const body = [
    'うちはペットを飼っている関係で、エアコンが年中稼働している。だから「夏は暑くて」「冬は寒くて」というような、部屋の気温がプロテインに影響することはほとんどない。',
    '',
    'ただ、季節で変わるものが一つだけある。**水道水の温度だ。**',
    '',
    '夏はぬるい水が出るし、冬は冷たい水が出る。プロテインを溶かすとき、実はここが一番効いている。',
    '',
    '## 冬だけ、シェイカーの振りが甘いと玉が残る',
    '',
    '夏や春、秋は、適当にシェイカーを振ってもだいたい溶ける。ところが冬場だけ、振り方が甘いと粉が固まって残ることがある。',
    '',
    '原因ははっきりしていて、**水が冷たいほどプロテインは溶けにくい。** 気温の話ではなく、コップに注ぐ水そのものの温度の話だった。',
    '',
    '## 冬は、水を2段階に分けて入れている',
    '',
    '対策として、冬場は水の入れ方を変えている。',
    '',
    '先に冷たい水道水を100mlくらい入れて、残りの50〜100mlをぬるま湯かお湯で足す。全部お湯にしないのは、たぶん熱すぎるとタンパク質の風味や粉の溶け方に影響しそうな気がして、なんとなく避けている（試して比較したわけではない）。',
    '',
    'この2段階にしてから、冬でも玉が残ることはほとんどなくなった。',
    '',
    '## まとめ',
    '',
    '- 部屋の気温よりも、水道水そのものの温度がプロテインの溶けやすさに影響している',
    '- 冬は水が冷たいので、振りが甘いと溶け残りやすい',
    '- 冷たい水100ml＋ぬるま湯・お湯50〜100mlの2段階にすると、冬でも溶けやすい'
  ].join('\n');

  sheet.appendRow([
    'tokenokori',
    'プロテインが溶け残るのは、季節のせいではなく水道水の温度だった',
    '部屋はペットのため年中エアコンで気温差がほぼ無い。それでも冬だけプロテインが溶け残るのは、水道水の温度が原因だった。冷水とぬるま湯を2段階に分けて入れる工夫の記録。',
    new Date(),
    new Date(),
    '公開',
    body
  ]);

  Logger.log('記事を追加しました: tokenokori。次に buildAllPages() を実行してください。');
  return '記事を追加しました。次に buildAllPages() を実行してください。';
}


/**
 * 新しい記事「飲み終えたシェイカーは、空だと思って油断していた」を
 * 追加する。飲み終えたつもりのシェイカーに底にわずかにプロテインが
 * 残っていて、蓋の閉め方が甘く漏れてベタついた・匂いが残った実体験と、
 * それ以来蓋をギチギチに閉める習慣がついた話。
 */
function addArticle_yudan() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);

  if (!sheet) {
    throw new Error('「記事」シートが見つかりません。先に setupArticleSheet() を実行してください。');
  }

  const body = [
    '飲み終えたシェイカーは、普段通り蓋を閉めたと思っていた。飲み終えたと思っていたが、実際は底にわずかにプロテインが残っていた。',
    '',
    '## 蓋が甘くて、少し漏れた',
    '',
    'その状態でシェイカーをそのまま持ち運んでいたら、蓋の閉め方が甘かったらしく、残っていた分がわずかに漏れた。内側がベタついているのに気づいたのは、持ち運んだ後だった。',
    '',
    '量としてはごくわずかだったが、触るとはっきり分かるくらいにはベタついていた。',
    '',
    '## 拭いても、匂いが残った',
    '',
    'すぐに拭いたが、匂いまでは取り切れなかった。プロテインの匂いは、液体をふき取ったくらいでは消えないらしい。',
    '',
    '結局、その日はベタつきと匂いが気になったまま過ごすことになった。',
    '',
    '## それ以来、蓋はギチギチに閉めている',
    '',
    'この件があってから、**空に近いシェイカーでも、蓋はギチギチに閉めるようになった。笑** 「もう空だから」という油断が原因だったので、残量に関係なく同じように閉める、というだけの話だが、効果はあった。あれ以来、同じことは起きていない。',
    '',
    '## まとめ',
    '',
    '- 飲み終えたシェイカーでも、底にわずかにプロテインが残っていることがある',
    '- 蓋の閉め方が甘いと、わずかな残量でも漏れて内側がベタつく',
    '- 拭いても匂いは残りやすい',
    '- 残量に関係なく、蓋はしっかり閉める習慣にしてから同じことは起きていない'
  ].join('\n');

  sheet.appendRow([
    'yudan',
    '飲み終えたシェイカーは、空だと思って油断していた',
    '飲み終えたつもりのシェイカーに、実は底にわずかにプロテインが残っていた。蓋の閉め方が甘く漏れてベタついた・匂いが残った話と、それ以来蓋をギチギチに閉めるようになった記録。',
    new Date(),
    new Date(),
    '公開',
    body
  ]);

  Logger.log('記事を追加しました: yudan。次に buildAllPages() を実行してください。');
  return '記事を追加しました。次に buildAllPages() を実行してください。';
}


/**
 * 新しい記事「プロテインの飲むタイミングは、いろいろ調べた末に気にしなく
 * なった」を追加する。筋トレ1〜2年目に回数・タイミング・量を調べたこと、
 * 今は朝か昼・筋トレ後・オフの日は寝る前の1日2〜3回であること、
 * 筋トレを何十年も続けたいので細かく気にしていないこと、という実体験に基づく。
 */
function addArticle_timing() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);

  if (!sheet) {
    throw new Error('「記事」シートが見つかりません。先に setupArticleSheet() を実行してください。');
  }

  const body = [
    'プロテインを飲むタイミングは、今は決めすぎないようにしている。',
    '',
    '## 今の飲み方',
    '',
    '基本は、朝か昼に1回、筋トレ後に1回。オフの日は、これに寝る前を加える。1日2〜3回になる。',
    '',
    '筋トレをしている人は、1日に体重1kgあたり1.5〜2gのタンパク質が目安とされているらしい。ただ、今はそこまで気にしていない。',
    '',
    '## 筋トレ1〜2年目は、かなり調べていた',
    '',
    '筋トレを始めて1〜2年目のころは、飲む回数、タイミング、量を、いろいろ調べていた。',
    '',
    '口にするものは、今でもできるだけ成分表を見るようにしている。ただ、**大きなストレスがかからない範囲にとどめている。**',
    '',
    '## 「今すぐ」ではなく「いつか」でやっている',
    '',
    '気にしなくなったのは、筋トレの考え方が根っこにあるからだ。',
    '',
    'ジムでの筋トレは、この先も何十年と続けていきたい。だから、「今すぐバキバキの身体になる」ことではなく、**時間をかけて、いつか理想の良い身体になること**を目指している。そう考えると、プロテインの飲み方で細かく悩むより、続けられることのほうが大事だと思った。',
    '',
    '## 結果、大きな変化はない',
    '',
    '細かく気にしなくなって、何か大きく変わったかというと、変わっていない。',
    '',
    '上がる重量は落ちていないし、維持できている。少なくとも自分の場合は、タイミングを細かく詰めなくても困っていない。',
    '',
    '## まとめ',
    '',
    '- 今は、朝か昼、筋トレ後、オフの日は寝る前の1日2〜3回',
    '- 筋トレ向けの目安（1日に体重1kgあたり1.5〜2g）は聞くが、今はそこまで気にしていない',
    '- 1〜2年目は調べていたが、「いつか理想の身体に」という考えで、今はストレスなく続けている',
    '- 気にしなくなっても、上がる重量は落ちず、維持できている'
  ].join('\n');

  sheet.appendRow([
    'timing',
    'プロテインの飲むタイミングは、いろいろ調べた末に気にしなくなった',
    '筋トレ1〜2年目はプロテインの回数・タイミング・量を調べた。今は朝か昼、筋トレ後、オフの日は寝る前の2〜3回に落ち着き、ストレスなく続けている記録。',
    new Date(),
    new Date(),
    '公開',
    body
  ]);

  Logger.log('記事を追加しました: timing。次に buildAllPages() を実行してください。');
  return '記事を追加しました。次に buildAllPages() を実行してください。';
}


/**
 * 新しい記事「2023年のマイプロテインの購入履歴を見返したら、安かったのは
 * 『割引』のおかげだった」を追加する。2023年9月1日（51%オフ・合計12,338円）と
 * 12月22日（60%オフ・合計10,948円）の購入履歴のスクリーンショットを使う。
 * 画像は事前に注文番号を伏せ、/assets/articles/ に置いてあること。
 * 割引前の価格は、割引額と支払額からの逆算（推定）として書いている。
 */
function addArticle_nedan2023() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);

  if (!sheet) {
    throw new Error('「記事」シートが見つかりません。先に setupArticleSheet() を実行してください。');
  }

  const body = [
    'プロテインが高くなったというニュースを最近よく見る。自分でも確かめたくなって、2023年のマイプロテインの購入履歴を見返してみた。',
    '',
    '## 2023年に買ったもの',
    '',
    '**2023年9月1日**',
    '',
    '- Impact ホエイ 2.5kg（チョコミント）6,169円',
    '- Impact ホエイ 2.5kg（ナチュラルストロベリー）6,169円',
    '- お試し用のプロテインクッキー（0円）',
    '- 合計12,338円（送料無料）',
    '',
    '5kgとクッキーで12,338円だった。いまのエクスプロージョン3kg（13,790円）より安い。',
    '',
    '{{img:order-2023-09-items.webp|2023年9月の注文内容。Impact ホエイ2.5kgが2袋とお試し用クッキー|640|1174|2023年9月1日の注文内容}}',
    '',
    '**2023年12月22日**',
    '',
    '- Impact ホエイ 2.5kg（チョコミント）5,838円',
    '- Impact ホエイ 1kg（ヨーグルト）2,555円',
    '- Impact ホエイ 1kg（ナチュラルストロベリー）2,555円',
    '- 合計10,948円（送料無料）',
    '',
    '{{img:order-2023-12-items.webp|2023年12月の注文内容。Impact ホエイ2.5kgが1袋と1kgが2袋|640|1098|2023年12月22日の注文内容}}',
    '',
    '## 安かったのは、割引が大きかったから',
    '',
    'どちらの注文にも、大きな割引がかかっていた。',
    '',
    '- 9月1日は「ほぼ全商品51%オフ」で、割引額は12,842円',
    '- 12月22日は「60%オフ」で、割引額は16,422円',
    '',
    '{{img:order-2023-09-summary.webp|2023年9月1日の注文詳細。51%オフで割引額12,842円、合計12,338円|640|905|2023年9月1日の注文詳細（注文番号は伏せています）}}',
    '',
    '{{img:order-2023-12-summary.webp|2023年12月22日の注文詳細。60%オフで割引額16,422円、合計10,948円|640|926|2023年12月22日の注文詳細（注文番号は伏せています）}}',
    '',
    '割引前の価格に戻すと、2.5kg1袋はおよそ12,600円〜14,600円、1kgあたり約5,000〜5,800円になる（割引額と支払額から逆算した推定）。実際に払ったのは、1kgあたり約2,300〜2,600円だった。',
    '',
    '**安かったのは、値段が低かったからではなく、割引が大きかったからだ。** 当時は、このクーポンが使えるのがマイプロテインの良いところだった。今は買っていないので、同じ割引が今も使えるのかは分からない。',
    '',
    '## 今のエクスプロージョン3kgと比べると',
    '',
    '今、このサイトの価格ログでは、エクスプロージョンのホエイ3kg（ミルクチョコレート）が13,790円になっている。1kgあたり約4,600円で、割引はない通常の販売価格だ。',
    '',
    '2023年の割引前の価格（1kgあたり約5,000〜5,800円）と比べると、特別に高くなったわけではない。ただ、実際に払った金額（1kgあたり約2,300〜2,600円）と比べると、約2倍近い。',
    '',
    'なお、買う場所（公式サイトと楽天）も商品も違うので、あくまで自分の購入履歴と今の価格を並べた目安だ。',
    '',
    '## 値上げは、公式にも発表されていた',
    '',
    '明治（ザバス）は2026年4月16日に、6月1日出荷分から、粉末プロテイン17品とプロテインバー4品の価格を引き上げると発表した。出荷価格で約6〜28%の引き上げで、理由はたんぱく原料の価格が急激に上がっていることだ。',
    '',
    '## このサイトの価格ログでは',
    '',
    'このサイトの価格ログは、8月27日から始まっている。ザバスの6月の値上げより後なので、値上げそのものは記録に写っていない。',
    '',
    '8月27日から10月12日までに、同じショップの同じ商品を追えたパウダー10商品で見ると、20gあたりの価格の中央値は229.3円から223.9円で、−2.3%だった。値上がりが3商品、値下がりが1商品、変化なしが6商品。GronGのホエイ ベーシック1kgは、9月21日から10月12日までの3週間で約10%上がっていた。',
    '',
    '## まとめ',
    '',
    '- 2023年に買ったマイプロテインは、51〜60%オフが効いて、1kgあたり約2,300〜2,600円だった',
    '- 割引前に戻すと、1kgあたり約5,000〜5,800円（逆算した推定）。今のエクスプロージョン3kgの約4,600円と、大きくは変わらない',
    '- 実際に払う金額が上がったと感じるのは、割引が効かなくなったぶんが大きいのかもしれない（今も同じ割引があるかは未確認）',
    '- 明治は2026年6月1日出荷分から約6〜28%の値上げを発表している',
    '- 価格ログで見た、8月末からの約6週間は、大きくは動いていなかった'
  ].join('\n');

  sheet.appendRow([
    'nedan-2023',
    '2023年のマイプロテインの購入履歴を見返したら、安かったのは「割引」のおかげだった',
    '2023年にマイプロテインで買った履歴を見返すと、5kg＋クッキーが12,338円。51%オフと60%オフのセールが効いていた。値上げの話題とあわせて整理した。',
    new Date(),
    new Date(),
    '公開',
    body
  ]);

  Logger.log('記事を追加しました: nedan-2023。次に buildAllPages() を実行してください。');
  return '記事を追加しました。次に buildAllPages() を実行してください。';
}


/**
 * 記事の本文・説明文に書いてある取得時刻の表記を、実際の運用に合わせる。
 * 自動実行は毎朝5:12ごろに動くので、「毎朝6時」「毎日6時」を
 * 「毎朝5〜6時ごろ」「毎日5〜6時」に直す。
 * 該当しなかった記事は触らない。変更した記事のIDと件数をログに出す。
 */
function fixPriceTimeInArticles() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  const header = values[0];

  const idCol = header.indexOf('記事ID');
  const targetCols = [header.indexOf('本文'), header.indexOf('説明（検索結果に出る文）')]
    .filter(function (c) { return c !== -1; });

  const replacements = [
    ['毎朝6時に', '毎朝5〜6時ごろに'],
    ['毎朝6時', '毎朝5〜6時ごろ'],
    ['毎日6時', '毎日5〜6時']
  ];

  const lines = [];

  for (let i = 1; i < values.length; i++) {
    let changed = 0;

    targetCols.forEach(function (col) {
      const original = String(values[i][col] || '');
      let updated = original;

      replacements.forEach(function (pair) {
        updated = updated.split(pair[0]).join(pair[1]);
      });

      if (updated !== original) {
        sheet.getRange(i + 1, col + 1).setValue(updated);
        changed++;
      }
    });

    if (changed > 0) {
      lines.push(String(values[i][idCol]).trim() + ': ' + changed + '箇所の欄を更新');
    }
  }

  const message = lines.length > 0
    ? lines.join('\n') + '\n\n次の手順: buildAllPages() を実行してサイトに反映。'
    : '該当する表記はありませんでした。';

  Logger.log(message);
  return message;
}
