/**
 * 04_Build.gs
 * 商品マスタと価格ログを読み、ページを作ってGitHubに置く。
 *
 * 作るもの
 *   /                       トップページ（1杯あたりの安い順）
 *   /items/<商品ID>/        個別の商品ページ
 *   /<記事ID>/              記事ページ
 *   /articles/              読みものの一覧
 *   /brands/<ブランドID>/   ブランド別の価格一覧（商品2件以上のブランドだけ）
 *   /methods/<製法>/        製法別の価格一覧（商品2件以上の製法だけ）
 *   /about/                 このサイトについて
 *   /privacy/               プライバシーポリシー
 *   /sitemap.xml            検索エンジン向けの地図
 *   /robots.txt
 *
 * 対象はステータスが「公開」の商品だけ。
 * 「準備中」「停止」はページを作らないので、公開したくない商品は
 * ステータスを戻せばよい（ただし既に置いたページは自動では消えない）。
 *
 * 【中身が変わっていないページは書き込まない】
 * GitHubへの書き込みは1件ずつAPIを叩くため、商品数が増えると時間がかかる。
 * 前回の内容と同じページは飛ばすことで、毎日の実行を短く保つ。
 * 記録は「ビルド記録」シートに残す。
 */

const BUILD = {
  RECORD_SHEET_NAME: 'ビルド記録',

  // GAS は1回の実行が6分で止まるので、1回あたりの書き込み上限を決めておく
  MAX_UPLOADS_PER_RUN: 60,

  // GitHub API を叩く間隔
  UPLOAD_INTERVAL_MS: 350,

  // 「これより安いもの」に出す最小の差額（円）。
  // 1杯7円の差で乗り換える人はいないので、僅差の候補は出さない。
  MIN_PRICE_DIFF: 10,

  // 「これより安いもの」に出す件数
  CHEAPER_COUNT: 3,

  // 「同じシリーズの他の味」に出す件数の上限
  SIBLING_COUNT: 8,

  // 絞り込みページを作る最小の商品数。
  // 1商品しかない一覧は中身が薄く、検索エンジンから低品質と見なされうるので作らない。
  MIN_GROUP_SIZE: 2
};

/**
 * 製法の系統。
 * ホエイを見ている人にソイを勧めても乗り換え先にならないので、
 * 系統をまたいだ比較はしない。
 * ミックスは中間なのでどちらにも寄せず、ミックス同士でだけ比べる。
 */
const METHOD_FAMILY = {
  'WPC': 'ホエイ',
  'WPI': 'ホエイ',
  'WPH': 'ホエイ',
  'ソイ': 'ソイ',
  'カゼイン': 'カゼイン',
  'ミックス': 'ミックス'
};

function methodFamily_(method) {
  return METHOD_FAMILY[String(method || '').trim()] || 'その他';
}

// ============================================================
// 公開関数
// ============================================================

/**
 * 全ページを作り直してGitHubに置く。
 * 変わっていないページは飛ばす。
 */
function buildAllPages() {
  const products = readMasterFull_();
  const published = products.filter(function (p) { return p.status === '公開'; });

  if (published.length === 0) {
    return 'ステータスが「公開」の商品がありません。管理画面から公開に切り替えてください。';
  }

  const history = readPriceHistory_();
  const entries = buildEntries_(published, history);

  if (entries.length === 0) {
    return '価格を取得できている公開商品がありません。runPriceFetch を実行してください。';
  }

  const updatedLabel = buildUpdatedLabel_(entries);
  const record = loadBuildRecord_();

  const pages = [];

  // 記事（07_Article.gs が入っていれば生成する）。
  // 商品ページの「あわせて読みたい」が記事を参照するため、商品ページより先に読み込む。
  const entriesById = {};
  entries.forEach(function (e) { entriesById[e.product.productId] = e; });

  const articleData = loadArticles_(entriesById);
  articleData.pages.forEach(function (page) { pages.push(page); });
  const articles = articleData.articles;
  const articlesByHref = articleData.byHref;

  // 個別ページ。
  // 前回のビルド時点の順位（rankRecord）と比べて、↑↓→を出す。
  // entry に rank / rankChange を持たせておくと、後段のトップページ・
  // ブランド別・製法別の一覧でも同じ矢印をそのまま使い回せる。
  const rankRecord = loadRankRecord_();

  entries.forEach(function (entry) {
    const ctx = buildItemContext_(entry, entries, updatedLabel, rankRecord);
    entry.rank = ctx.rank;
    entry.rankChange = ctx.rankChange;
    entry.rankPer20g = ctx.rankPer20g;
    entry.rankPer20gChange = ctx.rankPer20gChange;

    const html = buildItemHtml_(entry.product, entry.price, entry.history, ctx, articlesByHref);
    pages.push({ path: 'items/' + entry.product.productId + '/index.html', html: html });
  });

  saveRankRecord_(entries);

  // 読みもの一覧。
  // トップには最新数本しか出さないので、過去の記事の受け皿を用意する。
  if (articles.length > 0) {
    pages.push({
      path: 'articles/index.html',
      html: buildArticlesIndexHtml_(articles, { updatedLabel: updatedLabel })
    });
  }

  // 絞り込みページ（ブランド別・製法別）。
  // マスタと価格ログから自動で作られるので、書き足す原稿はない。
  const brandGroups = groupEntries_(entries, function (e) {
    const id = e.product.brandId;
    return id ? { key: id, name: e.product.brand || id, slug: id } : null;
  });

  const methodGroups = groupEntries_(entries, function (e) {
    const slug = methodSlug_(e.product.method);
    return slug ? { key: slug, name: e.product.method, slug: slug } : null;
  });

  brandGroups.forEach(function (g) {
    pages.push({
      path: 'brands/' + g.slug + '/index.html',
      html: buildBrandHtml_(g, g.entries, { updatedLabel: updatedLabel })
    });
  });

  methodGroups.forEach(function (g) {
    pages.push({
      path: 'methods/' + g.slug + '/index.html',
      html: buildMethodHtml_(g, g.entries, { updatedLabel: updatedLabel })
    });
  });

  // トップページ
  const indexEntries = entries.slice().sort(function (a, b) {
    if (a.product.form === 'RTD' && b.product.form !== 'RTD') return 1;
    if (a.product.form !== 'RTD' && b.product.form === 'RTD') return -1;
    return a.unitValue - b.unitValue;
  }).map(function (e) {
    return {
      product: e.product,
      price: e.price ? e.price.price : '',
      unitValue: e.unitValue,
      per20g: e.per20g,
      href: e.href,
      rankChange: e.rankChange
    };
  });

  pages.push({
    path: 'index.html',
    html: buildIndexHtml_(indexEntries, {
      updatedLabel: updatedLabel,
      articles: articles,
      brands: toChips_(brandGroups, 'brands'),
      methods: toChips_(methodGroups, 'methods')
    })
  });

  // 固定ページ。
  // 運営者情報とプライバシーポリシーは、ASPの審査でも見られる。
  pages.push({
    path: 'about/index.html',
    html: buildAboutHtml_({ updatedLabel: updatedLabel })
  });

  pages.push({
    path: 'privacy/index.html',
    html: buildPrivacyHtml_({ updatedLabel: updatedLabel })
  });

  // sitemap と robots
  pages.push({
    path: 'sitemap.xml',
    html: buildSitemap_(entries, articles, brandGroups, methodGroups),
    type: 'application/xml'
  });
  pages.push({ path: 'robots.txt', html: buildRobots_(), type: 'text/plain' });

  // 変わったものだけ書き込む
  let uploaded = 0;
  let skipped = 0;
  let stopped = false;
  const errors = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const digest = md5_(page.html);

    if (record[page.path] === digest) {
      skipped++;
      continue;
    }

    if (uploaded >= BUILD.MAX_UPLOADS_PER_RUN) {
      stopped = true;
      break;
    }

    try {
      putTextToGithub_(page.path, page.html, page.type || 'text/html');
      record[page.path] = digest;
      uploaded++;
    } catch (e) {
      errors.push(page.path + ': ' + e.message);
    }

    Utilities.sleep(BUILD.UPLOAD_INTERVAL_MS);
  }

  saveBuildRecord_(record);

  const message = [
    'ページを更新しました',
    '公開商品: ' + entries.length + '件 / 記事: ' + articles.length + '本',
    '絞り込み: ブランド ' + brandGroups.length + '件 / 製法 ' + methodGroups.length + '件',
    '書き込み: ' + uploaded + '件 / 変更なし: ' + skipped + '件',
    stopped ? '※ 上限に達したので途中で止めました。もう一度実行すると続きから進みます。' : '',
    errors.length ? '失敗 ' + errors.length + '件:\n' + errors.slice(0, 5).join('\n') : ''
  ].filter(Boolean).join('\n');

  Logger.log(message);
  return message;
}

/**
 * 記事一覧を読み込み、hrefで引けるようにする。
 *
 * 商品ページの「あわせて読みたい」はここで作った byHref を使って、
 * 記事の実際のタイトル・説明文をその場で参照する（商品側にコピーを持たせない）。
 * こうしておくと、記事のタイトルを直したときに商品ページ側が古いままにならない。
 *
 * 07_Article.gs が入っていないプロジェクトでも壊れないよう、
 * 関数が無ければ何も生成せず空を返す。
 */
function loadArticles_(entriesById) {
  if (typeof buildArticlePages_ !== 'function') {
    return { pages: [], articles: [], byHref: {} };
  }

  const pages = buildArticlePages_(entriesById);
  const articles = listArticles_();
  const byHref = {};

  articles.forEach(function (a) { byHref[a.href] = a; });

  return { pages: pages, articles: articles, byHref: byHref };
}

/**
 * 1商品だけ作り直す。見た目を確認したいときに使う。
 */
function buildOnePage(productId) {
  const targetId = productId || '';

  if (!targetId) {
    throw new Error('商品IDを指定してください。例: buildOnePage("exp-whey-milkchoco-3000")');
  }

  const products = readMasterFull_();
  const history = readPriceHistory_();
  const entries = buildEntries_(products.filter(function (p) { return p.status !== '停止'; }), history);
  const entry = entries.filter(function (e) { return e.product.productId === targetId; })[0];

  if (!entry) {
    throw new Error('価格を取得できている商品が見つかりません: ' + targetId);
  }

  const updatedLabel = buildUpdatedLabel_(entries);
  // 確認用の単発実行なので、順位記録は読むだけで書き換えない
  // （ここで保存すると、翌朝の本番ビルドの前回比較がずれてしまう）。
  const ctx = buildItemContext_(entry, entries, updatedLabel, loadRankRecord_());

  const entriesById = {};
  entries.forEach(function (e) { entriesById[e.product.productId] = e; });
  const articlesByHref = loadArticles_(entriesById).byHref;

  const html = buildItemHtml_(entry.product, entry.price, entry.history, ctx, articlesByHref);
  const path = 'items/' + targetId + '/index.html';

  putTextToGithub_(path, html);

  const record = loadBuildRecord_();
  record[path] = md5_(html);
  saveBuildRecord_(record);

  Logger.log('置きました: ' + siteUrl_(path));
  return siteUrl_(path);
}

/**
 * ビルド記録を消す。
 * 見た目を変えたのに一部のページが更新されないときに使う。
 */
function resetBuildRecord() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BUILD.RECORD_SHEET_NAME);

  if (sheet) {
    sheet.clear();
  }

  Logger.log('ビルド記録を消しました。次の実行で全ページを書き直します。');
  return 'ビルド記録を消しました。次の実行で全ページを書き直します。';
}

/**
 * 価格取得のあとに続けてページを更新する。
 * 毎日のトリガーはこちらに向けてもよい。
 */
function jobFetchAndBuild() {
  const fetched = runPriceFetch();
  const built = buildAllPages();
  const message = fetched + '\n---\n' + built;
  Logger.log(message);
  return message;
}

// ============================================================
// データの読み込み
// ============================================================

/**
 * 商品マスタを、ページ生成に必要な項目まで含めて読む。
 * 列はヘッダー名で探すので、並び順が変わっても動く。
 * 無い列は空として扱う（体験メモや画像URLは後から足された列のため）。
 */
function readMasterFull_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.MASTER_SHEET_NAME);

  if (!sheet) {
    throw new Error('シートが見つかりません: ' + CONFIG.MASTER_SHEET_NAME);
  }

  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  const col = {};
  values[0].forEach(function (name, index) {
    const key = String(name).trim();
    if (key && col[key] === undefined) col[key] = index;
  });

  function pick(row, name) {
    return col[name] === undefined ? '' : row[col[name]];
  }

  function text(row, name) {
    return String(pick(row, name) || '').trim();
  }

  function num(row, name) {
    const v = Number(pick(row, name));
    return isFinite(v) && v > 0 ? v : null;
  }

  const products = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const productId = text(row, '商品ID');

    if (!productId) continue;

    const capacity = num(row, '容量g');
    const servingSize = num(row, '1食あたりg');
    const proteinPerServing = num(row, 'タンパク質g/食');

    products.push({
      productId: productId,
      maker: text(row, 'メーカー'),
      brand: text(row, 'ブランド'),
      series: text(row, 'シリーズ'),
      flavor: text(row, '味'),
      form: text(row, '形態'),
      capacity: capacity,
      servingSize: servingSize,
      proteinPerServing: proteinPerServing,
      brandId: text(row, 'ブランドID'),
      method: text(row, '製法'),
      tags: text(row, 'タグ').split(',').map(function (t) { return t.trim(); }).filter(Boolean),
      status: text(row, 'ステータス'),
      imageUrl: text(row, '画像URL'),
      officialUrl: text(row, '公式URL'),
      aspProgram: text(row, 'ASP案件'),
      experience: text(row, '体験メモ'),
      totalProtein: (capacity && servingSize && proteinPerServing)
        ? (capacity / servingSize) * proteinPerServing
        : null,
      canonical: 'https://proteinzukan.com/items/' + productId + '/'
    });
  }

  return products;
}

/**
 * 価格ログを商品IDごとにまとめ、古い順に並べて返す。
 */
function readPriceHistory_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PRICE_LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return {};
  }

  const values = sheet.getDataRange().getValues();
  const col = {};

  values[0].forEach(function (name, index) {
    col[String(name).trim()] = index;
  });

  function pick(row, name) {
    return col[name] === undefined ? '' : row[col[name]];
  }

  const grouped = {};

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const productId = String(pick(row, '商品ID') || '').trim();
    const price = Number(pick(row, '価格'));

    if (!productId || !isFinite(price) || price <= 0) continue;

    if (!grouped[productId]) grouped[productId] = [];

    const at = pick(row, '取得日時');

    grouped[productId].push({
      at: at instanceof Date ? at : null,
      price: price,
      postage: String(pick(row, '送料') || ''),
      quantity: Number(pick(row, '入数')) || null,
      pricePerUnit: Number(pick(row, '1本あたり')) || null,
      pricePer20g: Number(pick(row, '20gあたり')) || null,
      url: String(pick(row, 'URL') || ''),
      imageUrl: String(pick(row, '画像URL') || ''),
      itemName: String(pick(row, '楽天での商品名') || ''),
      shopName: String(pick(row, 'ショップ名') || '')
    });
  }

  Object.keys(grouped).forEach(function (id) {
    grouped[id].sort(function (a, b) {
      if (!a.at || !b.at) return 0;
      return a.at.getTime() - b.at.getTime();
    });
  });

  return grouped;
}

// ============================================================
// 組み立て
// ============================================================

/**
 * 商品と価格を突き合わせ、ページ生成に使う形にまとめる。
 * 価格が1件も無い商品は落とす。
 */
function buildEntries_(products, history) {
  const entries = [];

  products.forEach(function (product) {
    const rows = history[product.productId];

    if (!rows || rows.length === 0) return;

    const latest = rows[rows.length - 1];
    const isRtd = product.form === 'RTD';
    const unitValue = isRtd ? latest.pricePerUnit : latest.pricePer20g;

    if (unitValue === null || !isFinite(unitValue)) return;

    // ドリンクでも「タンパク質20gあたり」を出す。
    // 1本の値段が安くても、タンパク質が少なければ割高になるため。
    let per20g = null;

    if (isRtd && product.proteinPerServing > 0 && latest.pricePerUnit) {
      per20g = Math.round(latest.pricePerUnit / product.proteinPerServing * 20 * 10) / 10;
    } else if (!isRtd) {
      per20g = latest.pricePer20g;
    }

    entries.push({
      product: product,
      price: latest,
      history: rows.map(function (r) { return { date: r.at, price: r.price }; }),
      unitValue: unitValue,
      per20g: per20g,
      isRtd: isRtd,
      href: '/items/' + product.productId + '/'
    });
  });

  return entries;
}

/**
 * 商品ページに渡す文脈（順位・相場の幅・これより安いもの）を作る。
 * 比べる相手は同じ形態のものだけにする。
 * パウダーとRTDを同じ物差しに乗せると、RTDが必ず負けて意味をなさないため。
 */
function buildItemContext_(entry, allEntries, updatedLabel, rankRecord) {
  const sameForm = allEntries.filter(function (e) {
    return (e.product.form === 'RTD') === entry.isRtd;
  }).sort(function (a, b) {
    return a.unitValue - b.unitValue;
  });

  const values = sameForm.map(function (e) { return e.unitValue; });
  const rank = sameForm.map(function (e) { return e.product.productId; }).indexOf(entry.product.productId) + 1;

  // ドリンクは「1本あたり」と「タンパク質20gあたり」で順位が入れ替わる。
  // 1本が安くてもタンパク質が少なければ、同じ量を摂るには何本も要るため。
  // 1本あたりの順位だけを出すと、下の「これより安いもの」と食い違って見える。
  const byPer20g = sameForm.slice().filter(function (e) {
    return e.per20g !== null && e.per20g !== undefined;
  }).sort(function (a, b) {
    return a.per20g - b.per20g;
  });

  const rankPer20g = byPer20g.map(function (e) {
    return e.product.productId;
  }).indexOf(entry.product.productId) + 1;

  // 比べる相手を絞る。
  // まず同じ製法だけで探し、候補が足りなければ同じ系統まで広げる。
  const family = methodFamily_(entry.product.method);

  const inFamily = sameForm.filter(function (e) {
    return methodFamily_(e.product.method) === family;
  });

  const sameMethod = inFamily.filter(function (e) {
    return String(e.product.method || '').trim() === String(entry.product.method || '').trim();
  });

  // 「これより安いもの」は、形態を問わずタンパク質20gあたりで比べる。
  //
  // ドリンクを1本あたりで比べると、タンパク質10gの商品が30gの商品より
  // 「安い」と表示されてしまう。同じ量を摂るには3本要るので、実際には安くない。
  // ページの上部で既にパウダー換算を出している以上、ここも同じものさしに揃える。
  function compareValue_(e) {
    return (e.per20g !== null && e.per20g !== undefined) ? e.per20g : e.unitValue;
  }

  const basis = compareValue_(entry);

  function cheaperThan(pool) {
    return pool.filter(function (e) {
      return compareValue_(e) <= basis - BUILD.MIN_PRICE_DIFF;
    });
  }

  let pool = cheaperThan(sameMethod);

  if (pool.length < 2) {
    pool = cheaperThan(inFamily);
  }

  pool = pool.slice().sort(function (a, b) {
    return compareValue_(a) - compareValue_(b);
  });

  // いちばん安いものと、すぐ下の数件を見せる。
  // 直近だけを並べると、大きく安い選択肢が抜け落ちるため。
  const picked = [];

  function add(candidate) {
    if (!candidate) return;
    const exists = picked.some(function (p) {
      return p.product.productId === candidate.product.productId;
    });
    if (!exists) picked.push(candidate);
  }

  add(pool[0]);
  pool.slice(-(BUILD.CHEAPER_COUNT - 1)).forEach(add);

  picked.sort(function (a, b) { return compareValue_(a) - compareValue_(b); });

  const cheaper = picked.slice(0, BUILD.CHEAPER_COUNT).map(function (e) {
    return {
      productId: e.product.productId,
      maker: e.product.maker,
      brand: e.product.brand,
      series: e.product.series,
      flavor: e.product.flavor,
      form: e.product.form,
      capacity: e.product.capacity,
      method: e.product.method,
      imageUrl: e.product.imageUrl,
      proteinPerServing: e.product.proteinPerServing,
      unitValue: e.unitValue,
      per20g: e.per20g,
      compareValue: compareValue_(e),
      price: e.price ? e.price.price : '',
      href: e.href
    };
  });

  // 同じシリーズの他の味。
  // 商品ページを見ている人は、その商品自体には興味がある状態なので、
  // 別ブランドを勧めるより先に「同じものの別の味」を見せたほうが役に立つ。
  //
  // シリーズ名の一致だけで判定すると、ブランドが違う商品同士が
  // 「ホエイプロテイン」のような汎用的なシリーズ名でたまたま一致し、
  // 無関係な商品が誤って「同じシリーズ」として出てしまう。
  // ブランドIDも一致することを条件に加えて防ぐ。
  const series = String(entry.product.series || '').trim();
  const brandId = String(entry.product.brandId || '').trim();

  const siblings = (!series || !brandId) ? [] : allEntries.filter(function (e) {
    return e.product.productId !== entry.product.productId &&
      String(e.product.series || '').trim() === series &&
      String(e.product.brandId || '').trim() === brandId;
  }).sort(function (a, b) {
    return a.unitValue - b.unitValue;
  }).slice(0, BUILD.SIBLING_COUNT).map(function (e) {
    return {
      flavor: e.product.flavor || e.product.series,
      capacity: e.product.capacity,
      form: e.product.form,
      unitValue: e.unitValue,
      href: e.href
    };
  });

  // 前回のビルド時点の順位と比べて、上がった／下がった／変わらないを出す。
  // 初めて順位が付いた商品（前回の記録が無い）は比べようがないので付けない。
  const prevRank = rankRecord && rankRecord[entry.product.productId];

  function rankChange_(current, previous) {
    if (!previous || !current) return null;
    if (current < previous) return 'up';
    if (current > previous) return 'down';
    return 'same';
  }

  return {
    rank: rank > 0 ? rank : null,
    total: sameForm.length,
    rankChange: rankChange_(rank, prevRank ? prevRank.rank : null),
    rankPer20g: rankPer20g > 0 ? rankPer20g : null,
    totalPer20g: byPer20g.length,
    rankPer20gChange: rankChange_(rankPer20g, prevRank ? prevRank.rankPer20g : null),
    compareBasis: basis,
    series: series,
    siblings: siblings,
    per20g: entry.per20g,
    minPer20g: values.length ? Math.min.apply(null, values) : null,
    maxPer20g: values.length ? Math.max.apply(null, values) : null,
    cheaper: cheaper,
    updatedLabel: updatedLabel
  };
}

/** 「8月27日 6:00 更新」のような表示を作る */
function buildUpdatedLabel_(entries) {
  let latest = null;

  entries.forEach(function (e) {
    if (e.price && e.price.at instanceof Date) {
      if (!latest || e.price.at > latest) latest = e.price.at;
    }
  });

  if (!latest) {
    return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日') + ' 更新';
  }

  return Utilities.formatDate(latest, 'Asia/Tokyo', 'M月d日 H:mm') + ' 更新';
}

/** sitemap.xml */
function buildSitemap_(entries, articles, brandGroups, methodGroups) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const list = articles || [];

  // 記事はトップの次に置く。検索エンジンに読ませたい順に並べる。
  const articleUrls = list.map(function (a) {
    return 'https://proteinzukan.com' + a.href;
  });

  // 記事があるときだけ一覧ページを載せる。
  // 記事0本のときは /articles/ を生成していないため。
  const listUrls = list.length ? ['https://proteinzukan.com/articles/'] : [];

  const urls = ['https://proteinzukan.com/']
    .concat(listUrls)
    .concat(articleUrls)
    .concat(entries.map(function (e) {
      return 'https://proteinzukan.com/items/' + e.product.productId + '/';
    }))
    .concat((brandGroups || []).map(function (g) {
      return 'https://proteinzukan.com/brands/' + g.slug + '/';
    }))
    .concat((methodGroups || []).map(function (g) {
      return 'https://proteinzukan.com/methods/' + g.slug + '/';
    }))
    .concat([
      'https://proteinzukan.com/about/',
      'https://proteinzukan.com/privacy/'
    ]);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  ].concat(urls.map(function (u) {
    return '<url><loc>' + u + '</loc><lastmod>' + today + '</lastmod></url>';
  })).concat(['</urlset>']).join('\n');
}

/** robots.txt */
function buildRobots_() {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    'Sitemap: https://proteinzukan.com/sitemap.xml'
  ].join('\n');
}

// ============================================================
// ビルド記録
// ============================================================

function md5_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

function loadBuildRecord_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BUILD.RECORD_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return {};
  }

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const record = {};

  values.forEach(function (row) {
    const path = String(row[0] || '').trim();
    if (path) record[path] = String(row[1] || '').trim();
  });

  return record;
}

function saveBuildRecord_(record) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(BUILD.RECORD_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(BUILD.RECORD_SHEET_NAME);
    sheet.hideSheet();
  }

  const rows = Object.keys(record).sort().map(function (path) {
    return [path, record[path]];
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, 2).setValues([['パス', '内容のハッシュ']]).setFontWeight('bold');

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  }
}

// ============================================================
// 順位記録
// ============================================================

const RANK_RECORD_SHEET_NAME = '順位記録';

/**
 * 前回のビルド時点の順位を読み込む。
 * 商品ページの「↑↓→」は、これと今回の順位を比べて出す。
 *
 * @return {Object} {商品ID: {rank, rankPer20g}}
 */
function loadRankRecord_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RANK_RECORD_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return {};
  }

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const record = {};

  values.forEach(function (row) {
    const productId = String(row[0] || '').trim();
    if (!productId) return;

    record[productId] = {
      rank: Number(row[1]) || null,
      rankPer20g: Number(row[2]) || null
    };
  });

  return record;
}

/**
 * 今回のビルドで出した順位を、次回の比較用に保存する。
 * 呼ぶのは buildAllPages のときだけでよい。
 * buildOnePage は確認用の単発実行なので、ここで記録を書き換えると
 * 翌朝の本番ビルドの比較がずれてしまう。
 *
 * @param {Array} entries buildEntries_ の結果。各要素に rank / rankPer20g が付いている前提。
 */
function saveRankRecord_(entries) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(RANK_RECORD_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(RANK_RECORD_SHEET_NAME);
    sheet.hideSheet();
  }

  const rows = entries
    .filter(function (e) { return e.rank || e.rankPer20g; })
    .map(function (e) {
      return [e.product.productId, e.rank || '', e.rankPer20g || ''];
    });

  sheet.clear();
  sheet.getRange(1, 1, 1, 3).setValues([['商品ID', '順位', '20gあたり順位']]).setFontWeight('bold');

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
}

/**
 * 商品をグループにまとめる（ブランド別・製法別で共通に使う）。
 *
 * classify は entry を受け取り {key, name, slug} を返す。
 * 対象外なら null を返す（ブランドIDが空、製法が未対応など）。
 *
 * 商品が MIN_GROUP_SIZE 未満のグループは落とす。
 * 1商品しかない一覧ページは中身が薄く、作っても読む人の役に立たないため。
 *
 * @return {Array} [{key, name, slug, entries}] 商品数の多い順
 */
function groupEntries_(entries, classify) {
  const map = {};

  entries.forEach(function (e) {
    const info = classify(e);

    if (!info || !info.key) return;

    if (!map[info.key]) {
      map[info.key] = { key: info.key, name: info.name, slug: info.slug, entries: [] };
    }

    map[info.key].entries.push(e);
  });

  const groups = [];

  Object.keys(map).forEach(function (key) {
    const g = map[key];

    if (g.entries.length < BUILD.MIN_GROUP_SIZE) return;

    // 一覧の中は安い順。パウダーを先、ドリンクを後ろにする。
    g.entries.sort(function (a, b) {
      if (a.product.form === 'RTD' && b.product.form !== 'RTD') return 1;
      if (a.product.form !== 'RTD' && b.product.form === 'RTD') return -1;
      return a.unitValue - b.unitValue;
    });

    groups.push(g);
  });

  // 商品数の多い順。同数なら名前順で安定させる。
  groups.sort(function (a, b) {
    if (b.entries.length !== a.entries.length) return b.entries.length - a.entries.length;
    return String(a.name).localeCompare(String(b.name), 'ja');
  });

  return groups;
}

/**
 * グループをトップページの絞り込みリンク用の形に直す。
 */
function toChips_(groups, dir) {
  return (groups || []).map(function (g) {
    return {
      name: g.name,
      href: '/' + dir + '/' + g.slug + '/',
      count: g.entries.length,
      key: g.slug
    };
  });
}
