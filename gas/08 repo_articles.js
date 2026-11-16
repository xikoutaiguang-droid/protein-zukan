/**
 * 08_RepoArticles.gs
 * リポジトリの _articles/ フォルダに置いた原稿も、記事として公開できるようにする。
 *
 * 【なぜ必要か】
 * これまで記事は「記事」シートからしか公開できなかった。
 * 担当Claude（毎日の定期タスク）はシートを触れないため、原稿を書いても
 * 西口さんがGASに貼って実行するまで公開されず、下書きが溜まっていた。
 * この仕組みを入れると、担当Claudeが _articles/<記事ID>.md を push するだけで、
 * 翌朝のビルド（jobFetchAndBuild → buildAllPages）で公開される。
 *
 * 【入れ方】
 * このファイルを「08 repo_articles」として、GASのファイル一覧で
 * 「07 article」より下に追加する。それだけで動く。
 * （同じ名前の関数 readArticles_ は、あとに読み込まれるこちらが使われる。
 *   紛らわしさを避けたい場合は、07 article の readArticles_ を消してよい。
 *   このファイルの readArticles_ はシートの読み込みも含んでいる。）
 * 入れたら checkRepoArticles() を1回実行して、読み込めるか確かめる。
 *
 * 【原稿ファイルの書き方】 _articles/<記事ID>.md
 *   ---
 *   id: lawson-protein
 *   title: ローソンのプロテイン飲料の値段｜…
 *   description: 検索結果に出る説明文
 *   published: 2026-11-20
 *   updated: 2026-11-25
 *   status: 公開
 *   ---
 *   本文（Markdown。{{item:..}} {{list:..}} {{pr:..}} {{img:..}} の埋め込みもシートと同じく使える）
 *
 *   - id はURLになる（https://proteinzukan.com/<id>/）。半角英小文字・数字・ハイフンだけ。
 *     省略したらファイル名（.md を除く）を使う。
 *   - status が「公開」で、published の日付が今日（日本時間）以前のものだけを公開する。
 *     先の日付にしておけば、その日の朝のビルドで自動的に公開される（書きため可）。
 *   - 「記事」シートに同じ記事IDがあれば、シートのほうを優先し、ファイルは使わない。
 *   - _ で始まるフォルダは GitHub Pages で配信されないので、原稿そのものはサイトに出ない。
 *     ただしリポジトリは公開なので、GitHub上では誰でも読める。
 *
 * 【失敗したとき】
 * GitHubから原稿を読めなかった場合は、ログに書いて、シートの記事だけでビルドを続ける
 * （毎朝のビルド全体は止めない）。
 */

const REPO_ARTICLE = {
  FOLDER: '_articles',

  // URLとして使えない（既存の仕組みと重なる）記事ID
  RESERVED_IDS: [
    'items', 'brands', 'methods', 'articles', 'assets', 'about', 'about-zukan',
    'privacy', 'gas', '_ops', '_articles', 'index', 'sitemap', 'robots'
  ]
};

// 1回の実行の中で何度も GitHub を読みに行かないためのキャッシュ
let REPO_ARTICLE_CACHE_ = null;

// ============================================================
// 公開関数
// ============================================================

/**
 * リポジトリの原稿が読めるか確かめる。シートにもGitHubにも書き込まない。
 */
function checkRepoArticles() {
  REPO_ARTICLE_CACHE_ = null;

  const result = readRepoArticlesDetailed_();
  const lines = [];

  lines.push('フォルダ: ' + REPO_ARTICLE.FOLDER + '/');
  lines.push('読み込んだファイル: ' + result.fileCount + '件');
  lines.push('公開する記事: ' + result.articles.length + '件');

  result.articles.forEach(function (a) {
    lines.push('  公開 /' + a.slug + '/ ' + a.title + '（' + a.publishedLabel + '）');
  });

  result.skipped.forEach(function (s) {
    lines.push('  見送り ' + s.file + ' … ' + s.reason);
  });

  if (result.error) {
    lines.push('エラー: ' + result.error);
  }

  const sheetSlugs = readSheetArticles_().map(function (a) { return a.slug; });
  const overlap = result.articles.filter(function (a) { return sheetSlugs.indexOf(a.slug) !== -1; });

  overlap.forEach(function (a) {
    lines.push('  ※ /' + a.slug + '/ は「記事」シートにもあるので、シートのほうを使います');
  });

  const message = lines.join('\n');
  Logger.log(message);
  return message;
}

// ============================================================
// 記事の読み込み（07 article の readArticles_ を置き換える）
// ============================================================

/**
 * 公開する記事をすべて返す。
 * 「記事」シートの記事に、リポジトリの _articles/ の記事を足したもの。
 * 同じ記事IDがあればシートを優先する。
 */
function readArticles_() {
  const sheetArticles = readSheetArticles_();
  const used = {};

  sheetArticles.forEach(function (a) { used[a.slug] = true; });

  let repoArticles = [];

  try {
    repoArticles = readRepoArticles_();
  } catch (err) {
    Logger.log('リポジトリの原稿を読めませんでした（シートの記事だけで続けます）: ' + err);
    repoArticles = [];
  }

  const merged = sheetArticles.slice();

  repoArticles.forEach(function (a) {
    if (used[a.slug]) {
      Logger.log('記事ID「' + a.slug + '」はシートにもあるため、_articles/ の原稿は使いません。');
      return;
    }
    used[a.slug] = true;
    merged.push(a);
  });

  return merged;
}

/**
 * 「記事」シートから、ステータスが「公開」の記事を読む。
 * （07 article の元の readArticles_ と同じ内容）
 */
function readSheetArticles_() {
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

/**
 * リポジトリの _articles/ から、公開する記事を読む。
 */
function readRepoArticles_() {
  const result = readRepoArticlesDetailed_();

  if (result.error) {
    throw new Error(result.error);
  }

  result.skipped.forEach(function (s) {
    Logger.log('_articles/ の見送り: ' + s.file + ' … ' + s.reason);
  });

  return result.articles;
}

/**
 * _articles/ を読み、公開する記事・見送ったファイル・エラーを返す。
 * 1回の実行の中では結果を使い回す（buildAllPages の中で何度も呼ばれるため）。
 */
function readRepoArticlesDetailed_() {
  if (REPO_ARTICLE_CACHE_) {
    return REPO_ARTICLE_CACHE_;
  }

  const result = { articles: [], skipped: [], fileCount: 0, error: '' };

  let files;

  try {
    files = listRepoArticleFiles_();
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
    REPO_ARTICLE_CACHE_ = result;
    return result;
  }

  result.fileCount = files.length;

  if (files.length === 0) {
    REPO_ARTICLE_CACHE_ = result;
    return result;
  }

  let texts;

  try {
    texts = fetchRepoArticleTexts_(files);
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
    REPO_ARTICLE_CACHE_ = result;
    return result;
  }

  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const seen = {};

  files.forEach(function (file, index) {
    const parsed = parseRepoArticle_(texts[index]);

    if (!parsed) {
      result.skipped.push({ file: file.name, reason: '先頭の「---」で囲んだ項目が読めません' });
      return;
    }

    const meta = parsed.meta;
    const slug = String(meta.id || file.name.replace(/\.md$/i, '')).trim();

    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      result.skipped.push({ file: file.name, reason: '記事ID「' + slug + '」に使えない文字があります（半角英小文字・数字・ハイフンのみ）' });
      return;
    }

    if (REPO_ARTICLE.RESERVED_IDS.indexOf(slug) !== -1) {
      result.skipped.push({ file: file.name, reason: '記事ID「' + slug + '」は既存の仕組みと重なるので使えません' });
      return;
    }

    if (seen[slug]) {
      result.skipped.push({ file: file.name, reason: '記事ID「' + slug + '」が別のファイルと重なっています' });
      return;
    }

    const status = String(meta.status || '').trim();

    if (status !== '公開') {
      result.skipped.push({ file: file.name, reason: 'status が「公開」ではありません（' + (status || '未記入') + '）' });
      return;
    }

    const title = String(meta.title || '').trim();

    if (!title) {
      result.skipped.push({ file: file.name, reason: 'title がありません' });
      return;
    }

    const published = parseYmd_(meta.published);

    if (!published) {
      result.skipped.push({ file: file.name, reason: 'published の日付が読めません（例 2026-11-20）' });
      return;
    }

    if (published.ymd > today) {
      result.skipped.push({ file: file.name, reason: '公開日 ' + published.ymd + ' がまだ来ていません' });
      return;
    }

    if (!parsed.body.trim()) {
      result.skipped.push({ file: file.name, reason: '本文がありません' });
      return;
    }

    const updated = parseYmd_(meta.updated);

    seen[slug] = true;

    result.articles.push({
      slug: slug,
      title: title,
      description: String(meta.description || '').trim(),
      publishedLabel: published.label,
      updatedLabel: updated ? updated.label : '',
      publishedAt: published.date,
      // シートの行より後ろ（＝同じ日付ならシートより新しい扱い）に並べる
      order: 100000 + index,
      body: parsed.body
    });
  });

  REPO_ARTICLE_CACHE_ = result;
  return result;
}

// ============================================================
// GitHub から読む
// ============================================================

/**
 * _articles/ の .md ファイルの一覧（名前順）。フォルダが無ければ空。
 */
function listRepoArticleFiles_() {
  const repo = prop_('GITHUB_REPO');
  const branch = prop_('GITHUB_BRANCH', 'main');
  const token = prop_('GITHUB_TOKEN');
  const api = GITHUB.API_BASE + '/repos/' + repo + '/contents/' + REPO_ARTICLE.FOLDER +
    '?ref=' + encodeURIComponent(branch);

  const res = UrlFetchApp.fetch(api, {
    method: 'get',
    headers: ghHeaders_(token),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();

  if (code === 404) {
    return [];
  }

  if (code !== 200) {
    throw new Error('_articles/ の一覧を取得できません（HTTP ' + code + '）: ' + res.getContentText().slice(0, 200));
  }

  const items = JSON.parse(res.getContentText());

  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter(function (item) { return item.type === 'file' && /\.md$/i.test(item.name); })
    .map(function (item) { return { name: item.name, path: item.path }; })
    .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
}

/**
 * 原稿ファイルの中身（文字列）をまとめて取る。files と同じ順番で返す。
 */
function fetchRepoArticleTexts_(files) {
  const repo = prop_('GITHUB_REPO');
  const branch = prop_('GITHUB_BRANCH', 'main');
  const token = prop_('GITHUB_TOKEN');

  const headers = ghHeaders_(token);
  headers['Accept'] = 'application/vnd.github.raw+json';

  const requests = files.map(function (file) {
    return {
      url: GITHUB.API_BASE + '/repos/' + repo + '/contents/' + encodeURI(file.path) +
        '?ref=' + encodeURIComponent(branch),
      method: 'get',
      headers: headers,
      muteHttpExceptions: true
    };
  });

  const responses = UrlFetchApp.fetchAll(requests);

  return responses.map(function (res, index) {
    const code = res.getResponseCode();
    if (code !== 200) {
      throw new Error(files[index].name + ' を取得できません（HTTP ' + code + '）');
    }
    return res.getContentText('UTF-8');
  });
}

// ============================================================
// 原稿の読み取り
// ============================================================

/**
 * 先頭の「---」〜「---」の項目と、本文に分ける。
 * 項目は「名前: 値」の1行ずつ。値の前後の引用符は外す。
 *
 * @return {{meta: Object, body: string}|null}
 */
function parseRepoArticle_(text) {
  const normalized = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    return null;
  }

  const meta = {};

  match[1].split('\n').forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*)$/);
    if (!m) return;

    let value = m[2].trim();

    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
        (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      value = value.slice(1, -1);
    }

    meta[m[1].toLowerCase()] = value;
  });

  return { meta: meta, body: match[2] };
}

/**
 * 「2026-11-20」「2026/11/20」を読み、比較用・表示用・日付の3つを返す。
 */
function parseYmd_(value) {
  const m = String(value || '').trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);

  if (!m) {
    return null;
  }

  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);

  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    return null;
  }

  const pad = function (n) { return (n < 10 ? '0' : '') + n; };

  return {
    ymd: y + '-' + pad(mo) + '-' + pad(d),
    label: y + '年' + mo + '月' + d + '日',
    date: new Date(y, mo - 1, d)
  };
}
