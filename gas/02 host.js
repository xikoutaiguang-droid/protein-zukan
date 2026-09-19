/**
 * 02_Host.gs
 * 生成したHTMLをGitHubのリポジトリに置き、GitHub Pages で公開する。
 *
 * 絵本Instagramの 05_Host.gs をベースにしている。
 * 違いは、画像(Blob)ではなくHTML(テキスト)を主に扱う点。
 *
 * 【事前準備（スクリプトプロパティ）】
 *   GITHUB_TOKEN   … Fine-grained token（Contents: Read and write）
 *   GITHUB_REPO    … xikoutaiguang-droid/protein-zukan
 *   GITHUB_BRANCH  … main
 *
 * 【重要】
 * リポジトリ直下の CNAME ファイルは独自ドメインの設定なので、
 * このコードから消さないこと。ここでは追加と更新しか行わない。
 */

const GITHUB = {
  API_BASE: 'https://api.github.com',
  USER_AGENT: 'protein-zukan-gas',
  API_VERSION: '2022-11-28'
};

/** サイトの公開URL（独自ドメイン） */
const SITE_ORIGIN = 'https://proteinzukan.com';

// ============================================================
// プロパティ
// ============================================================

/**
 * スクリプトプロパティを読む。
 * 未設定なら分かりやすいエラーを出す（fallback を渡した場合はそれを返す）。
 */
function prop_(key, fallback) {
  const value = PropertiesService.getScriptProperties().getProperty(key);

  if (value === null || value === '') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error('スクリプトプロパティ「' + key + '」が未設定です。');
  }

  return String(value).trim();
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

// ============================================================
// GitHub
// ============================================================

function ghHeaders_(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB.API_VERSION,
    'User-Agent': GITHUB.USER_AGENT
  };
}

/**
 * Blob をGitHubに置く。既にあれば上書きする。
 *
 * @param {string} path リポジトリ内のパス（例 items/sav-whey-cocoa-980.html）
 * @param {Blob} blob
 * @return {string} raw の公開URL
 */
function uploadToGithub_(path, blob) {
  const repo = prop_('GITHUB_REPO');
  const branch = prop_('GITHUB_BRANCH', 'main');
  const token = prop_('GITHUB_TOKEN');
  const api = GITHUB.API_BASE + '/repos/' + repo + '/contents/' + encodeURI(path);

  // 短時間に大量のファイルを連続コミットすると、直前にGETしたshaが
  // 別のコミットの反映タイミングとぶつかって409（衝突）になることがある。
  // 一度だけなら再度shaを取り直して書き直せば直るので、数回まで再試行する。
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 既存ファイルを上書きするには sha が要る
    let sha = null;
    const check = UrlFetchApp.fetch(api + '?ref=' + encodeURIComponent(branch), {
      method: 'get',
      muteHttpExceptions: true,
      headers: ghHeaders_(token)
    });

    const checkCode = check.getResponseCode();

    if (checkCode === 200) {
      sha = JSON.parse(check.getContentText()).sha;
    } else if (checkCode === 401 || checkCode === 403) {
      throw new Error(
        'GitHubの認証に失敗しました（' + checkCode + '）。' +
        'トークンの権限と、Repository access に ' + repo + ' が含まれているか確認してください。'
      );
    } else if (checkCode === 404) {
      // ファイルが無いだけなら新規作成に進む。
      // リポジトリ自体が無い場合もここに来るので、後続のPUTで判別する。
      sha = null;
    }

    const payload = {
      message: 'update ' + path,
      content: Utilities.base64Encode(blob.getBytes()),
      branch: branch
    };

    if (sha) {
      payload.sha = sha;
    }

    const res = UrlFetchApp.fetch(api, {
      method: 'put',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: ghHeaders_(token),
      payload: JSON.stringify(payload)
    });

    const code = res.getResponseCode();

    if (code === 200 || code === 201) {
      return 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + encodeURI(path);
    }

    if (code === 409 && attempt < MAX_ATTEMPTS) {
      Utilities.sleep(500);
      continue;
    }

    throw new Error('GitHubへの書き込みに失敗しました（' + code + '）: ' + res.getContentText().slice(0, 300));
  }
}

/**
 * テキスト（HTMLなど）をGitHubに置く。
 *
 * @param {string} path リポジトリ内のパス
 * @param {string} text 中身
 * @param {string} mimeType 省略時は text/html
 * @return {string} raw の公開URL
 */
function putTextToGithub_(path, text, mimeType) {
  const type = mimeType || 'text/html';
  const name = path.split('/').pop();
  const blob = Utilities.newBlob(text, type, name);
  return uploadToGithub_(path, blob);
}

/**
 * GitHub上のファイルを削除する。
 *
 * マスタから外れた（停止/削除済みの）商品ページなど、孤立して
 * 古い価格のまま残り続けるファイルを片付けるために使う。
 * buildAllPages は新規追加・更新はするが削除はしないため、
 * 不要になったページはこの関数で明示的に消す必要がある。
 *
 * @param {string} path リポジトリ内のパス（例 items/xxx/index.html）
 * @return {boolean} 削除できたら true、そもそも無かったら false
 */
function deleteFromGithub_(path) {
  const repo = prop_('GITHUB_REPO');
  const branch = prop_('GITHUB_BRANCH', 'main');
  const token = prop_('GITHUB_TOKEN');
  const api = GITHUB.API_BASE + '/repos/' + repo + '/contents/' + encodeURI(path);

  const check = UrlFetchApp.fetch(api + '?ref=' + encodeURIComponent(branch), {
    method: 'get',
    muteHttpExceptions: true,
    headers: ghHeaders_(token)
  });

  if (check.getResponseCode() === 404) {
    return false;
  }

  if (check.getResponseCode() !== 200) {
    throw new Error('GitHubの確認に失敗しました（' + check.getResponseCode() + '）: ' + check.getContentText().slice(0, 300));
  }

  const sha = JSON.parse(check.getContentText()).sha;

  const res = UrlFetchApp.fetch(api, {
    method: 'delete',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: ghHeaders_(token),
    payload: JSON.stringify({
      message: 'delete ' + path,
      sha: sha,
      branch: branch
    })
  });

  const code = res.getResponseCode();

  if (code !== 200) {
    throw new Error('GitHubからの削除に失敗しました（' + code + '）: ' + res.getContentText().slice(0, 300));
  }

  return true;
}

/**
 * リポジトリ内のパスから、サイト上の公開URLを組み立てる。
 * index.html はディレクトリのURLに畳む。
 */
function siteUrl_(path) {
  let cleaned = String(path).replace(/^\/+/, '');

  if (cleaned === 'index.html') {
    return SITE_ORIGIN + '/';
  }

  cleaned = cleaned.replace(/\/index\.html$/, '/');
  return SITE_ORIGIN + '/' + cleaned;
}

// ============================================================
// 接続確認
// ============================================================

/**
 * GitHubへの書き込みが通るか確認する。
 * health/check.txt を1つ置くだけ。サイトの見た目には影響しない。
 */
function checkGithub() {
  const lines = [];

  try {
    lines.push('リポジトリ: ' + prop_('GITHUB_REPO'));
    lines.push('ブランチ: ' + prop_('GITHUB_BRANCH', 'main'));
    lines.push('トークン先頭: ' + prop_('GITHUB_TOKEN').slice(0, 12) + '...');
  } catch (e) {
    Logger.log('設定に不足があります: ' + e.message);
    return '設定に不足があります: ' + e.message;
  }

  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  try {
    const url = putTextToGithub_(
      'health/check.txt',
      'protein-zukan connection check\n' + stamp + '\n',
      'text/plain'
    );

    lines.push('書き込み成功');
    lines.push(url);

    Logger.log(lines.join('\n'));
    return '成功しました。GitHubのリポジトリに health/check.txt ができています。';
  } catch (e) {
    lines.push('書き込み失敗: ' + e.message);
    Logger.log(lines.join('\n'));
    return '失敗: ' + e.message;
  }
}

/**
 * 動作確認用に、サイトのトップへ仮のページを1枚置く。
 * 本番のトップページは後で 04_Build.gs が上書きする。
 */
function putPlaceholderIndex() {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<title>プロテイン図鑑</title>',
    '<style>',
    'body{margin:0;background:#F7F6F2;color:#131518;',
    'font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;',
    'display:flex;min-height:100vh;align-items:center;justify-content:center}',
    '.box{text-align:center;padding:24px}',
    'h1{font-size:20px;margin:0 0 8px;letter-spacing:.04em}',
    'p{color:#8A8F94;font-size:13px;margin:0}',
    '.bar{width:48px;height:4px;background:#DCE64B;margin:16px auto 0}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="box">',
    '<h1>プロテイン図鑑</h1>',
    '<p>準備中です</p>',
    '<div class="bar"></div>',
    '</div>',
    '</body>',
    '</html>'
  ].join('\n');

  try {
    putTextToGithub_('index.html', html);
    Logger.log('仮のトップページを置きました: ' + siteUrl_('index.html'));
    return '仮のトップページを置きました。反映まで数分かかります。';
  } catch (e) {
    Logger.log('失敗: ' + e.message);
    return '失敗: ' + e.message;
  }
}