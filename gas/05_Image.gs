/**
 * 05_Image.gs
 * 商品画像を選ぶ。
 *
 * 楽天の商品画像は出店者がアップしたもので、「まとめ買いクーポン付」
 * 「8本」「No.1」といった販促文字が焼き込まれていることが多い。
 * アイコンとして並べたときに見分けがつきにくくなるので、
 * Google Vision API で画像内の文字が占める面積を測り、
 * 一番文字の少ないものを選ぶ。
 *
 * 【事前準備】
 * スクリプトプロパティ VISION_API_KEY に Cloud Vision の APIキーを入れる。
 * ブランドタグOCRで使っているものと同じキーで動く。
 *
 * 【費用の目安】
 * 1画像あたり約0.0015ドル。200商品×3候補で約0.9ドル。
 * 毎日回す処理ではなく、商品を追加したときだけ実行する。
 *
 * 【使い方】
 * 1. pickBestImages()          … 候補を集めて採点し「画像選定」シートに出す
 * 2. シートを目で見て確認する（推奨が妥当か、手で直したいものはないか）
 * 3. applyBestImagesToMaster() … 推奨URLを商品マスタの画像URL列へ書き込む
 *
 * 商品マスタの画像URL列に既に値が入っている商品は、
 * 手動で選んだものとみなして上書きしない。
 */

const IMAGE_PICK = {
  // 選定結果を並べるシート
  SHEET_NAME: '画像選定',

  // 1商品あたり何件の候補を採点するか
  CANDIDATES: 3,

  // Vision API
  VISION_URL: 'https://vision.googleapis.com/v1/images:annotate',

  // これを超える文字面積の画像は「文字が多い」と印を付ける（目安）
  BUSY_THRESHOLD: 0.12
};

// ============================================================
// 公開関数
// ============================================================

/**
 * 候補画像を集めて採点し、「画像選定」シートに並べる。
 * 商品マスタは書き換えない。
 */
function pickBestImages() {
  const credentials = getCredentials_();
  const visionKey = prop_('VISION_API_KEY');
  const products = readMaster_(false);

  if (products.length === 0) {
    throw new Error('商品マスタに行がありません。');
  }

  const rows = [];
  let scored = 0;

  products.forEach(function (product) {
    if (!product.keyword) {
      return;
    }

    let items;
    try {
      items = searchRakuten_(credentials, product.keyword, CONFIG.TEST_HITS);
    } catch (e) {
      rows.push([product.productId, buildDisplayName_(product), '', '', '', '', 'エラー: ' + e.message, '']);
      Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
      return;
    }

    // 採用可のものを優先し、足りなければ除外されたものも候補に入れる
    const ok = [];
    const ng = [];

    items.forEach(function (item) {
      if (!item.imageUrl) {
        return;
      }
      const evaluated = evaluateItem_(product, item);
      (evaluated.rejectReason ? ng : ok).push({ item: item, reason: evaluated.rejectReason });
    });

    const picked = ok.concat(ng).slice(0, IMAGE_PICK.CANDIDATES);

    if (picked.length === 0) {
      rows.push([product.productId, buildDisplayName_(product), '', '(画像候補なし)', '', '', '', '']);
      Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
      return;
    }

    // まとめてVisionに投げる
    let coverages;
    try {
      coverages = measureTextCoverage_(visionKey, picked.map(function (p) { return p.item.imageUrl; }));
      scored += picked.length;
    } catch (e) {
      coverages = picked.map(function () { return null; });
      Logger.log('Vision失敗 ' + product.productId + ': ' + e.message);
    }

    // 一番文字の少ないものを推奨にする。測れなかったものは最後尾に回す。
    let bestIndex = -1;
    let bestValue = Infinity;

    coverages.forEach(function (c, i) {
      if (c !== null && c < bestValue) {
        bestValue = c;
        bestIndex = i;
      }
    });

    if (bestIndex === -1) {
      bestIndex = 0;
    }

    picked.forEach(function (p, index) {
      const coverage = coverages[index];
      const pct = coverage === null ? '' : Math.round(coverage * 1000) / 10;

      const note = [];
      if (index === bestIndex) note.push('推奨');
      if (coverage !== null && coverage > IMAGE_PICK.BUSY_THRESHOLD) note.push('文字多め');
      if (p.reason) note.push(p.reason);

      rows.push([
        product.productId,
        buildDisplayName_(product),
        index + 1,
        '=IMAGE("' + p.item.imageUrl + '",1)',
        pct,
        p.item.cleanName,
        note.join(' / '),
        p.item.imageUrl
      ]);
    });

    Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
  });

  const header = ['商品ID', '表示名', '順位', '画像', '文字面積%', '楽天での商品名', '判定', '画像URL'];

  writeSheet_(IMAGE_PICK.SHEET_NAME, header, rows);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(IMAGE_PICK.SHEET_NAME);

  if (sheet && rows.length > 0) {
    sheet.setRowHeights(2, rows.length, 110);
    sheet.setColumnWidth(2, 200);
    sheet.setColumnWidth(4, 130);
    sheet.setColumnWidth(6, 340);
    sheet.setColumnWidth(8, 120);
  }

  const message = '画像を採点しました: ' + rows.length + '行 / Vision呼び出し ' + scored + '件';
  Logger.log(message);
  return message;
}

/**
 * 「画像選定」シートで推奨になっている画像URLを、商品マスタの画像URL列へ書き込む。
 * 既に値が入っている行は手動で選んだものとみなして触らない。
 */
function applyBestImagesToMaster() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const pickSheet = spreadsheet.getSheetByName(IMAGE_PICK.SHEET_NAME);

  if (!pickSheet) {
    throw new Error('シートがありません。先に pickBestImages を実行してください: ' + IMAGE_PICK.SHEET_NAME);
  }

  const pickValues = pickSheet.getDataRange().getValues();
  const best = {};

  for (let i = 1; i < pickValues.length; i++) {
    const productId = String(pickValues[i][0]).trim();
    const note = String(pickValues[i][6]);
    const imageUrl = String(pickValues[i][7]).trim();

    if (productId && imageUrl && note.indexOf('推奨') !== -1) {
      best[productId] = imageUrl;
    }
  }

  const masterSheet = spreadsheet.getSheetByName(CONFIG.MASTER_SHEET_NAME);
  const masterValues = masterSheet.getDataRange().getValues();
  const headerRow = masterValues[0];

  const idIndex = headerRow.indexOf('商品ID');
  const imageIndex = headerRow.indexOf('画像URL');

  if (idIndex === -1 || imageIndex === -1) {
    throw new Error('商品マスタに「商品ID」または「画像URL」の列が見つかりません。');
  }

  let written = 0;
  let skipped = 0;

  for (let i = 1; i < masterValues.length; i++) {
    const productId = String(masterValues[i][idIndex]).trim();

    if (!productId || !best[productId]) {
      continue;
    }

    const current = String(masterValues[i][imageIndex]).trim();

    if (current) {
      skipped++;
      continue;
    }

    masterSheet.getRange(i + 1, imageIndex + 1).setValue(best[productId]);
    written++;
  }

  const message = '画像URLを書き込みました: ' + written + '件（既に入力済みのため見送り: ' + skipped + '件）';
  Logger.log(message);
  return message;
}

// ============================================================
// Vision API
// ============================================================

/**
 * 画像に写っている文字が、画像全体の何割を占めるかを測る。
 *
 * @param {string} apiKey
 * @param {Array<string>} imageUrls 最大16件
 * @return {Array<number|null>} 0〜1の割合。測れなければ null
 */
function measureTextCoverage_(apiKey, imageUrls) {
  if (!imageUrls.length) {
    return [];
  }

  const payload = {
    requests: imageUrls.map(function (url) {
      return {
        image: { source: { imageUri: url } },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }]
      };
    })
  };

  const res = UrlFetchApp.fetch(IMAGE_PICK.VISION_URL + '?key=' + encodeURIComponent(apiKey), {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code !== 200) {
    throw new Error('Vision API エラー ' + code + ': ' + body.slice(0, 300));
  }

  const json = JSON.parse(body);
  const responses = json.responses || [];

  return imageUrls.map(function (url, i) {
    const r = responses[i];

    if (!r || r.error) {
      return null;
    }

    const annotation = r.fullTextAnnotation;

    // 文字がまったく無い画像。これが理想。
    if (!annotation || !annotation.pages || !annotation.pages.length) {
      return 0;
    }

    const page = annotation.pages[0];
    const area = Number(page.width || 0) * Number(page.height || 0);

    if (!area) {
      return null;
    }

    let textArea = 0;

    (page.blocks || []).forEach(function (block) {
      textArea += polygonArea_(block.boundingBox);
    });

    return Math.min(1, textArea / area);
  });
}

/**
 * boundingBox の面積を求める。
 * Vision は座標が0のとき x や y を省略して返すので、欠けていたら0として扱う。
 */
function polygonArea_(boundingBox) {
  if (!boundingBox || !boundingBox.vertices || boundingBox.vertices.length < 3) {
    return 0;
  }

  const v = boundingBox.vertices;
  let sum = 0;

  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    sum += (Number(a.x || 0) * Number(b.y || 0)) - (Number(b.x || 0) * Number(a.y || 0));
  }

  return Math.abs(sum) / 2;
}
