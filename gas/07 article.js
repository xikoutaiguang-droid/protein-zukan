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

  const withTokens = String(body || '').replace(/\{\{(item|list|pr):([^}]+)\}\}/g, function (whole, kind, rest) {
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
