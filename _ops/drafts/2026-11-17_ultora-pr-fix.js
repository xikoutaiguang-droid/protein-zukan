/**
 * 下書き（未実行）: 「記事」シートの ULTORA PRカード（{{pr:...}}）を、公式の現行表示に合わせる一時関数。
 * 作成: 2026-11-17 担当Claude。西口さんの確認後、GASに貼って実行 → buildAllPages()。実行後は消してよい。
 *
 * 背景（ULTORA公式 https://ultora.co.jp/shop/products/U0470002 を 2026-11-16・17 に閲覧）:
 *   - チョコ(U0470002)の商品名は「ホエイプロテイン フォー ボディメイク チョコレート風味 810g」（RENEWAL表示）。
 *     サイトのPRカードは旧名「ホエイダイエットプロテイン チョコレート味 810g」のまま（aji-shippai）。
 *   - ミルクティー(U0470009)の商品ページは、11/14・11/16・11/17 の3回ともPCのChromeでエラー画面。
 *     doko-de-kau のPRカードのリンク先が開けない可能性がある。
 *
 * 使い方:
 *   1) checkUltoraPr_() を実行 → ログで、どの記事にどのPRカードがあるか確認（シートは変えない）
 *   2) fixUltoraPrNames_() を実行 → 旧商品名を新しい名前に置き換える（リンクはそのまま）
 *   3) （任意）ミルクティーのリンク先をチョコに替えるなら swapMilkteaToChoco_() を実行
 *   4) buildAllPages()
 */

const ULTORA_FIX_ = {
  OLD_CHOCO: 'ホエイダイエットプロテイン チョコレート味 810g',
  NEW_CHOCO: 'ホエイプロテイン フォー ボディメイク チョコレート風味 810g',
  OLD_MILK: 'ホエイダイエットプロテイン ミルクティー風味 810g',
  // ミルクティーの現行名は公式ページが開けず未確認のため、「フォー ボディメイク」は付けない
  NEW_MILK: 'ホエイプロテイン ミルクティー風味 810g',
  // A8 のリンクは a8ejpredirect（遷移先）の部分だけが違う。a8mat はそのまま使う
  MILK_TARGET: 'U0470009%3Fproduct_id%3D68517',
  CHOCO_TARGET: 'U0470002%3Fproduct_id%3D68510'
};

function ultoraBodyCol_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf('本文') + 1;
  if (col < 1) throw new Error('「本文」列が見つかりません');
  return col;
}

/** 確認だけ。シートは変更しない。 */
function checkUltoraPr_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);
  const col = ultoraBodyCol_(sheet);
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  const bodies = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
  bodies.forEach(function (r, i) {
    const m = String(r[0]).match(/\{\{pr:[^}]*ultora[^}]*\}\}/gi) || [];
    m.forEach(function (s) {
      Logger.log(ids[i][0] + ' : ' + s.split('|')[0] + ' / ' + (s.indexOf(ULTORA_FIX_.MILK_TARGET) >= 0 ? 'ミルクティーのリンク' : s.indexOf(ULTORA_FIX_.CHOCO_TARGET) >= 0 ? 'チョコのリンク' : 'その他'));
    });
  });
}

function replaceInBodies_(fn) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ARTICLE.SHEET_NAME);
  const col = ultoraBodyCol_(sheet);
  const range = sheet.getRange(2, col, sheet.getLastRow() - 1, 1);
  const values = range.getValues();
  let changed = 0;
  const out = values.map(function (r) {
    const before = String(r[0]);
    const after = fn(before);
    if (after !== before) changed++;
    return [after];
  });
  if (changed) range.setValues(out);
  Logger.log('変更した記事: ' + changed + '件');
}

/** 商品名だけを置き換える（リンク先は変えない）。 */
function fixUltoraPrNames_() {
  replaceInBodies_(function (s) {
    return s.split(ULTORA_FIX_.OLD_CHOCO).join(ULTORA_FIX_.NEW_CHOCO)
            .split(ULTORA_FIX_.OLD_MILK).join(ULTORA_FIX_.NEW_MILK);
  });
}

/**
 * ミルクティーのPRカードを、チョコ(U0470002)へのリンクに替える。
 * カードの商品名・遷移先を替え、画像（ミルクティーの写真）は外す。一言（note）はそのまま。
 */
function swapMilkteaToChoco_() {
  replaceInBodies_(function (s) {
    return s.replace(/\{\{pr:[^}]*\}\}/g, function (embed) {
      if (embed.indexOf(ULTORA_FIX_.MILK_TARGET) < 0) return embed;
      const parts = embed.slice(5, -2).split('|');
      parts[0] = 'ULTORA ' + ULTORA_FIX_.NEW_CHOCO;
      parts[1] = parts[1].split(ULTORA_FIX_.MILK_TARGET).join(ULTORA_FIX_.CHOCO_TARGET);
      if (parts.length > 3) parts.length = 3;
      return '{{pr:' + parts.join('|') + '}}';
    });
  });
}
