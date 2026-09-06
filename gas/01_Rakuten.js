/**
 * プロテイン図鑑 — 楽天市場 価格取得
 *
 * 2026年の楽天ウェブサービス仕様変更に対応した版。
 *   - エンドポイントは openapi.rakuten.co.jp / IchibaItem/Search/20260401
 *   - applicationId（UUID形式）と accessKey の両方が必須
 *   - Origin / Referer ヘッダに「許可されたウェブサイト」のドメインが必要
 *
 * 形態ごとに扱いを変える:
 *   パウダー   … 20gあたり単価で比較。小分け・トライアル・セット販売を除外
 *   スティック … 小分けが本命なので除外を緩める
 *   RTD        … まとめ売りが本命。商品名から入数を抽出して1本単価を出す
 *
 * 用途:
 *   checkCredentials()   … 認証情報が正しいか確認する
 *   checkMaster()        … 商品マスタの健康診断（APIは叩かない）
 *   runSearchTest()      … 検索キーワードが機能するか確認する（上位N件を並べる）
 *   diagnoseProduct()    … 1商品だけを詳しく調べる（0件になる理由を突き止める）
 *   runKeywordTest()     … 手入力キーワードを試す
 *   collectImages()      … 画像候補を並べる
 *   runPriceFetch()      … 本番。ステータス「公開」の商品を価格ログに追記する
 *   createDailyTrigger() … 毎日の自動実行を設定する
 *
 * 事前準備:
 *   GASエディタ → 左下の歯車（プロジェクトの設定）→ スクリプト プロパティ
 *     RAKUTEN_APP_ID       … 楽天管理画面の「アプリケーションID」（UUID形式）
 *     RAKUTEN_ACCESS_KEY   … 同じ画面の「アクセスキー」（pk_ で始まる）
 *     RAKUTEN_AFFILIATE_ID … 楽天アフィリエイトのID（任意・4ブロックの英数字）
 *
 * アフィリエイトIDを入れると、APIが返す商品URLがそのままアフィリエイトリンクになる。
 * 商品ごとに手でリンクを作る必要がないので、毎日の自動更新と両立できる。
 * 入れなくても動く（そのときは報酬が発生しない通常のリンクになる）。
 *
 * ------------------------------------------------------------
 * 2026-09-01 の改訂点（キーワード検証の結果で見つかった穴をふさいだ）
 * ------------------------------------------------------------
 *
 * 1. ふるさと納税がショップ名からしか判別できない件
 *    「千葉県富津市」のような自治体出品は、商品名に「ふるさと納税」と書かれない。
 *    ショップ名が自治体名そのものかどうかを見て除外する。
 *
 * 2. 同一略称の別ブランドを拾う件
 *    「バルクス」で検索すると バルクスポーツ／HALEO が返る。
 *    しかも価格が安いので、そのまま最安値として採用されてしまう。
 *    マスタの「ブランド」列ごとに、混ざってはいけない語を持たせて弾く。
 *
 * 3. 同一ブランドの別ラインを拾う件
 *    WPCの行にWPI（アイソレート）が入る。マスタの「製法」列と突き合わせる。
 *
 * 4. 味の照合がなかった件
 *    チョコレートの行に抹茶・カフェオレが「採用可」で入っていた。
 *    マスタの「味」列と商品名を突き合わせる。
 *
 * 5. 味が選択制の商品を拾う件
 *    「8種類の味から選べる」「フレーバーおまかせ」は、返る価格が
 *    単品価格と一致しない。商品名から選択制を検出して除外する。
 *
 * 6. RTDに容量照合がなかった件
 *    200mlの行に430mlが入りうる状態だった。
 *    430mlはタンパク質15gと30gが混在しているので、外すと単価が2倍ずれる。
 *
 * 7. キーワード検証モードで除外判定が走っていなかった件
 *    商品IDを指定しない行は形態も容量も不明なので、容量照合もパウダー除外も
 *    素通りして全部「採用可」と出ていた（1kgで検索して500gが採用可になっていた）。
 *    商品IDがない場合はキーワード自身から容量・形態・味を推定して照合する。
 *
 * 8. 上位30件が小分け・サンプルで埋まる件
 *    価格の安い順に取っているので、枠が試供品で埋まって本命が入らない。
 *    複数ページを取って母数を増やし、可能ならAPI側でも除外する。
 *
 * ------------------------------------------------------------
 * 除外を強める方向に倒してある理由
 * ------------------------------------------------------------
 * 除外しすぎた場合は「検索テスト」の判定列に理由が出るので目で気づける。
 * 除外し足りない場合は、間違った価格が黙ってサイトに出る。
 * 後者のほうが取り返しがつかないので、迷う場合は除外する側にしてある。
 *
 * 締めすぎて必要な商品まで落ちるときは、CONFIG.STRICT の該当項目を false にすると
 * その判定だけを止められる。1つずつ切って原因を絞り込めるようにしてある。
 */

// ============================================================
// 設定
// ============================================================

/**
 * diagnoseProduct() で調べたい商品ID。
 * 0件になる商品を1つずつここに書き換えて実行する。
 */
const DIAGNOSE_TARGET_ID = 'exp-whey-milkchoco-300';

const CONFIG = {
  // 商品マスタのシート名（タブの名前と一致させること）
  MASTER_SHEET_NAME: 'protein-master-template',

  // 出力先のシート名（存在しなければ自動で作られる）
  TEST_SHEET_NAME: '検索テスト',
  PRICE_LOG_SHEET_NAME: '価格ログ',

  // キーワードを試すための入力シートと結果シート
  KEYWORD_INPUT_SHEET_NAME: 'キーワード検証',
  KEYWORD_RESULT_SHEET_NAME: 'キーワード検証結果',

  // 商品画像を目視で確認するためのシート
  IMAGE_CHECK_SHEET_NAME: '画像確認',

  // 画像確認で1商品あたり何件並べるか
  IMAGE_CANDIDATES: 3,

  // 検索テストで何件並べるか
  TEST_HITS: 5,

  // 本番取得で何件取ってから選ぶか（除外が効くので多めに取る）
  FETCH_HITS: 30,

  // 本番取得で何ページまで取るか。
  // 1ページ30件が上限なので、2ページで60件が母数になる。
  // 価格の安い順に取っている都合で、1ページ目が小分け・サンプルで
  // 埋まってしまうことがある。その場合でも2ページ目に本命が入る。
  // 増やすほど実行時間とAPIリクエスト数が増えるので、まずは2で様子を見る。
  FETCH_PAGES: 2,

  // 検索テスト・キーワード検証で何ページまで取るか（確認用なので1で足りる）
  TEST_PAGES: 1,

  // リクエスト間隔（楽天APIは1秒1リクエストが上限。余裕を持たせる）
  REQUEST_INTERVAL_MS: 1200,

  // Origin / Referer に乗せるドメイン。
  // 楽天の管理画面「許可されたウェブサイト」に登録した値と一致させること。
  ORIGIN: 'https://proteinzukan.com',

  // 20gあたり単価の下限。これを下回る結果は小分け・試供品とみなして除外する。
  // 国内で最も安いWPCでも50円前後なので、30円は安全な床。
  MIN_PRICE_PER_20G: 30,

  // 20gあたり単価の上限。これを超える結果はセット販売や別商品とみなす。
  // パウダーとスティックにのみ適用（RTDは構造的に高くなるため対象外）。
  MAX_PRICE_PER_20G: 400,

  // RTDで抽出を許容する入数の範囲。
  // 上限を24本にしているのは、コンビニで買う商品を紹介するページで
  // 「48本入り12,797円」を最安として出しても現実的でないため。
  // 1ケース（24本）までを、買える単位として扱う。
  MIN_QUANTITY: 2,
  MAX_QUANTITY: 24,

  // 容量の一致とみなす誤差。1%か5gの大きいほう。
  // 980gと1000gは別商品として扱いたいので、緩くしすぎない。
  WEIGHT_TOLERANCE_RATIO: 0.01,
  WEIGHT_TOLERANCE_MIN: 5,

  // 商品名に別の味がいくつ並んでいたら「選択制」とみなすか。
  // 「チョコレート ベリー ヨーグルト カフェオレ バナナ 抹茶」のように
  // 味が羅列されている商品ページは、返る価格が単品価格と一致しない。
  MULTI_FLAVOR_THRESHOLD: 4,

  // API側の除外キーワード（NGKeyword）を使うか。
  // 2026年版エンドポイントで対応しているか公式資料で確認できていないため、
  // 拒否された場合は自動でオフにして、GAS側の除外だけで動き続ける。
  USE_API_NG_KEYWORD: true,

  // NGKeyword の長さ上限（半角換算）。全角は2文字として数える。
  NG_KEYWORD_MAX_HALF_WIDTH: 110,

  /**
   * 判定を個別にオン・オフする。
   * 除外されすぎたときは、ここを1つずつ false にして原因を絞り込む。
   */
  STRICT: {
    // ショップ名が自治体名ならふるさと納税として除外する
    SHOP_MUNICIPALITY: true,

    // マスタの「ブランド」と混ざってはいけない語を弾く
    BRAND_NG: true,

    // マスタの「シリーズ」と混ざってはいけない語を弾く
    // （ザバスの Shape&Beauty と MILK PROTEIN 脂肪0 を分ける）
    SERIES_NG: true,

    // マスタの「製法」と矛盾する語を弾く（WPCの行にWPIが入るのを防ぐ）
    METHOD_CONFLICT: true,

    // 味が選択制の商品ページを弾く
    MULTI_FLAVOR: true,

    // マスタの「味」と商品名を突き合わせる
    FLAVOR_MATCH: true,

    // 商品名に味の記載がまったくない場合も除外する。
    // 締めすぎて0件になる商品が出たら、まずここを false にする。
    FLAVOR_REQUIRE_MATCH: true,

    // RTDでも容量（ml）を照合する
    RTD_VOLUME: true,

    // RTDで容量の記載がない商品も除外する。
    // 430mlにタンパク質15gと30gが混在しているため、既定では除外する。
    RTD_REQUIRE_VOLUME: true
  },

  // 2026年の仕様変更後のエンドポイント
  // 20220601 は 2026/08/17 に廃止済み。20260401 が現行バージョン。
  API_ENDPOINT: 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401'
};

/**
 * NGKeyword が使えるかどうか。
 * 1度でも拒否されたら以降のリクエストでは付けない。
 */
let NG_KEYWORD_SUPPORTED = true;

/**
 * 形態を問わず除外するキーワード。
 * 寄付額を価格として取ってしまう「ふるさと納税」が最も危険。
 */
const COMMON_EXCLUDE_KEYWORDS = [
  'ふるさと納税',
  '寄附',
  '寄付',
  '中古',
  '訳あり',
  '福袋',
  '詰め合わせ',
  'まとめ買い'
];

/**
 * パウダーでのみ除外するキーワード。
 * 小分け・試供品・複数袋セットが最安値として拾われるのを防ぐ。
 * スティックとRTDには適用しない（そちらでは本命になりうるため）。
 */
const POWDER_EXCLUDE_KEYWORDS = [
  'トライアル',
  'お試し',
  '小分け',
  '分包',
  '1食分',
  '一食分',
  '袋セット',
  '種セット',
  'サンプル'
];

/**
 * API側に渡す除外キーワード。
 * 上位30件の枠が試供品や寄付で埋まるのを、取得の段階で減らす狙い。
 *
 * 注意: NGKeyword が AND 条件で解釈される可能性がある（公式資料に明記がない）。
 * その場合ほとんど効かないが、害はない。GAS側の除外は今までどおり全件に走るので、
 * ここが効かなくても判定の精度は落ちない。
 */
const NG_KEYWORD_COMMON = ['ふるさと納税', '中古', '訳あり', '福袋'];
const NG_KEYWORD_POWDER = ['サンプル', 'お試し', '小分け'];

/**
 * ブランドごとに「商品名に入っていたら別物」とみなす語。
 *
 * VALX を「バルクス」で検索すると バルクスポーツ が返る。
 * 価格が安いため、そのまま最安値として採用されてしまう。
 * エクスプロージョンでSMPをWPCとして表示した事故と同じ構図。
 *
 * ブランドを増やしたときは、ここに1行足すか、必要なければ足さなくてよい。
 * 該当がないブランドはこの判定を素通りする。
 */
const BRAND_NG_KEYWORDS = {
  'VALX': ['バルクスポーツ', 'BULKSPORTS', 'BULK SPORTS', 'HALEO', 'ハレオ', 'ビッグホエイ', 'マイプロテイン', 'MYPROTEIN', 'ビーレジェンド'],
  'バルクスポーツ': ['VALX', 'HALEO', 'ハレオ', 'マイプロテイン', 'MYPROTEIN'],
  'エクスプロージョン': ['スキムミルク', 'SMP', 'カゼイン', 'ソイプロテイン', 'マイプロテイン'],
  'ザバス': ['ジュニア', 'ウイダー', 'weider'],
  'DNS': ['ウイダー', 'weider'],
  'マイプロテイン': ['VALX', 'バルクスポーツ', 'ビーレジェンド'],
  'オイコス': ['ダノンビオ', 'ベビーダノン'],
  'グリコ': ['ウイダー']
};

/**
 * 製法ごとに「商品名に入っていたら別ライン」とみなす語。
 * マスタの「製法」列（wpc / wpi / wph / soy / casein / mix）を見る。
 *
 * 大文字小文字は無視して照合する。
 */
const METHOD_CONFLICTS = {
  'wpc': ['WPI', 'アイソレート', 'カゼイン', 'スキムミルク', 'SMP', 'ソイプロテイン', '大豆プロテイン'],
  'wpi': ['WPC', 'コンセントレート', 'カゼイン', 'スキムミルク', 'SMP', 'ソイプロテイン', '大豆プロテイン'],
  'wph': ['WPC', 'WPI', 'カゼイン', 'ソイプロテイン'],
  'soy': ['ホエイプロテイン', 'WPC', 'WPI', 'カゼイン'],
  'casein': ['ホエイプロテイン', 'WPC', 'WPI', 'ソイプロテイン'],
  'mix': []
};

/**
 * 味の表記ゆれ。
 * マスタの「味」列の値をキーに、商品名で使われうる表記を並べる。
 *
 * 「ミルク」と「プレーン」は他の語の一部として出てくるので特別扱いしている。
 * 「ミルクプロテイン」「ミルクチョコレート」に反応させないため、
 * ミルクは「ミルク風味」「ミルク味」のように後ろに語が付く形だけを認める。
 */
const FLAVOR_ALIASES = {
  'チョコレート': ['チョコレート', 'チョコ', 'ショコラ', 'CHOCOLATE', 'CHOCO'],
  'ミルクチョコレート': ['ミルクチョコ', 'チョコレート', 'チョコ', 'CHOCOLATE'],
  'ダブルチョコレート': ['ダブルチョコ', 'チョコレート', 'チョコ'],
  'ココア': ['ココア', 'COCOA'],
  'バニラ': ['バニラ', 'VANILLA'],
  'リッチバニラ': ['リッチバニラ', 'バニラ', 'VANILLA'],
  // ザバス ミルクプロテイン 200ml では「イチゴ風味」と「ストロベリー風味」が
  // 別商品として並んでいて、タンパク質量が 15g と 20g で違う。
  // ここを相互に別名として持たせると、15gの行が20gの商品を拾って
  // 単価が3割ずれる。同じ味に見えても混ぜないこと。
  'ストロベリー': ['ストロベリー', 'STRAWBERRY'],
  'イチゴ': ['イチゴ', 'いちご', '苺'],
  'バナナ': ['バナナ', 'BANANA'],
  'ヨーグルト': ['ヨーグルト', 'YOGURT', 'YOGHURT'],
  'カフェオレ': ['カフェオレ', 'カフェ・オレ', 'カフェオーレ'],
  'カフェラテ': ['カフェラテ', 'カフェ・ラテ', 'LATTE'],
  '抹茶': ['抹茶', 'MATCHA', '宇治'],
  'ミルクティー': ['ミルクティー', 'ミルクティ', 'ロイヤルミルクティー'],
  'ピーチ': ['ピーチ', '白桃', '桃', 'PEACH'],
  'キウイ': ['キウイ', 'KIWI'],
  'ライチ': ['ライチ', 'LYCHEE'],
  'マンゴー': ['マンゴー', 'MANGO'],
  'アーモンド': ['アーモンド', 'ALMOND'],
  'キャラメル': ['キャラメル', 'CARAMEL'],
  'レモン': ['レモン', 'LEMON'],
  'マスカット': ['マスカット', 'MUSCAT'],
  'ベリー': ['ベリー', 'BERRY'],
  'コーヒー': ['コーヒー', '珈琲', 'COFFEE'],
  'ミルク': ['ミルク風味', 'ミルク味', 'ミルクテイスト'],
  'プレーン': ['プレーン', 'ノンフレーバー', 'ナチュラル', 'PLAIN', 'NATURAL']
};

/**
 * 「選択制の商品ページ」を検出するために数える味の語。
 *
 * 「ミルク」「プレーン」は他の語の一部として出やすいので数に入れない。
 * ここに並んだ語が CONFIG.MULTI_FLAVOR_THRESHOLD 種類以上ある商品名は、
 * 味を選ばせるページとみなして除外する。
 */
const FLAVOR_TOKENS_FOR_COUNT = [
  'チョコ', 'ココア', 'バニラ', 'ストロベリー', 'いちご', 'イチゴ', 'バナナ',
  'ヨーグルト', 'カフェオレ', 'カフェラテ', '抹茶', 'ミルクティー', 'ピーチ',
  'キウイ', 'ライチ', 'マンゴー', 'アーモンド', 'キャラメル', 'レモン',
  'マスカット', 'ベリー', 'コーヒー', 'メロン', 'ぶどう', 'グレープ',
  'パイン', 'ラムネ', 'サイダー', 'コーラ', 'あずき', 'きなこ'
];

/**
 * 味が選択制であることを示す語。
 * 1つでも入っていれば、味の数を数えるまでもなく除外する。
 *
 * 「シリーズ」を入れているのは、マイプロテインの
 * 「（チョコレート・フルーツシリーズ）1kg」のような
 * 商品群まとめページを弾くため。
 * これで落としたくない商品が出たら、この配列から外す。
 */
const MULTI_FLAVOR_MARKERS = [
  '選べる',
  '選べます',
  'お好きな',
  'おまかせ',
  'お任せ',
  'その他のフレーバー',
  'フレーバーおまかせ',
  '各種',
  '全種類',
  '種類の味',
  '種類から',
  '種類より',
  'シリーズ',
  '味を選択',
  'フレーバー選択',
  'アソート',
  'バラエティ',
  '飲み比べ',
  '味比べ'
];

/**
 * 味の末尾に付くが、商品名では省略されることがある語。
 *
 * グリコの「マイルドカカオ微糖」「コーヒー微糖」は、
 * ショップによっては「マイルドカカオ」までしか書かない。
 * 末尾のこれらを外した形も一致とみなす。
 *
 * 甘さ違いで別商品が存在する場合は、下の FLAVOR_CONFLICTS で
 * 取り違えを防ぐこと（例: 微糖版が砂糖不使用版を拾わないようにする）。
 */
const OPTIONAL_FLAVOR_SUFFIXES = ['微糖', '加糖', '無糖', '低糖'];

/**
 * 「目的の味が書いてあっても、この語が併記されていたら別商品」という組み合わせ。
 *
 * ザバス200mlの「イチゴ風味(15g)」と「ストロベリー風味(20g)」は別商品だが、
 * ショップの商品名には検索対策で両方の語が入ることがある。
 *   例: 「ミルクプロテイン15g … イチゴ風味 … ストロベリー」
 * 味の一致だけを見ると20gの行がこの15g品を拾い、単価が3割低く出る。
 *
 * グリコは同じ味で微糖版と砂糖不使用版があるため、そちらも分ける。
 */
const FLAVOR_CONFLICTS = {
  'ストロベリー': ['イチゴ', 'いちご', '苺'],
  'イチゴ': ['ストロベリー', 'STRAWBERRY'],
  'ナッツミックス': ['砂糖不使用'],
  'マイルドカカオ微糖': ['砂糖不使用'],
  'コーヒー微糖': ['砂糖不使用']
};

/**
 * シリーズごとに「商品名に入っていたら別ライン」とみなす語。
 * マスタの「シリーズ」列と完全一致で引く。
 *
 * ザバスには MILK PROTEIN 脂肪0 のほかに Shape&Beauty、BIOPRO、
 * のむヨーグルトなど、容量も味も似た別ラインがある。
 * ブランドはどれも「ザバス」なので、ブランド単位では分けられない。
 *
 * 将来そのラインの商品をマスタに足すときは、ここから該当語を外すこと。
 */
const SERIES_NG_KEYWORDS = {
  'ミルクプロテイン 脂肪0': ['Shape&Beauty', 'シェイプ&ビューティー', 'のむヨーグルト', 'BIOPRO', 'ビオプロ'],
  'のむヨーグルト': ['BIOPRO', 'ビオプロ', 'Shape&Beauty'],
  'BIOPRO': ['のむヨーグルト', 'Shape&Beauty'],
  'プロテイン 脂肪0': ['ミルクプロテイン', 'MILK PROTEIN']
};

// 商品マスタから読む列（ヘッダー名で探すので、列の順番が変わっても動く）
const MASTER_COLUMNS = {
  productId: '商品ID',
  brand: 'ブランド',
  series: 'シリーズ',
  flavor: '味',
  form: '形態',
  capacity: '容量g',
  servingSize: '1食あたりg',
  proteinPerServing: 'タンパク質g/食',
  keyword: '検索キーワード',
  status: 'ステータス'
};

/**
 * あれば読むが、無くても止めない列。
 * 「製法」はマスタに後から足した列なので、無い環境でも動くようにしておく。
 */
const OPTIONAL_MASTER_COLUMNS = {
  method: '製法'
};

// ============================================================
// 公開関数
// ============================================================

/**
 * 認証情報の確認。
 * 実際にAPIを1回だけ叩いて、通るかどうかを見る。
 * 商品マスタもシートも触らない。
 */
function checkCredentials() {
  const credentials = getCredentials_();

  Logger.log('--- スクリプトプロパティの状態 ---');
  Logger.log('アプリID 文字数: ' + credentials.appId.length);
  Logger.log('アプリID 先頭8文字: ' + credentials.appId.slice(0, 8));
  Logger.log('アクセスキー 文字数: ' + credentials.accessKey.length);
  Logger.log('アフィリエイトID: ' + (credentials.affiliateId
    ? '設定あり（' + credentials.affiliateId.split('.').length + 'ブロック）'
    : '未設定 — 報酬は発生しません'));
  Logger.log('Origin: ' + CONFIG.ORIGIN);
  Logger.log('エンドポイント: ' + CONFIG.API_ENDPOINT);

  Logger.log('--- テストリクエスト ---');

  try {
    const items = searchRakuten_(credentials, 'ザバス ホエイプロテイン', 3, { pages: 1 });
    Logger.log('成功。' + items.length + '件ヒットしました。');

    items.forEach(function (item, index) {
      Logger.log((index + 1) + '位: ' + item.cleanName + ' / ' + item.itemPrice + '円 / ' + item.shopName);
    });

    Logger.log('NGKeyword: ' + (NG_KEYWORD_SUPPORTED ? '使用可' : '拒否されたため未使用'));

    return '認証に成功しました。runSearchTest を実行してください。';
  } catch (e) {
    Logger.log('失敗: ' + e.message);
    return '認証に失敗しました: ' + e.message;
  }
}

/**
 * 商品マスタの健康診断。APIは叩かない。
 * 商品IDの重複、容量の入力ミス、必須項目の欠けを一覧にする。
 *
 * 価格取得の前にこれを実行しておくと、
 * 「静かに間違った価格が出る」事故を先に潰せる。
 */
function checkMaster() {
  const products = readMaster_(false);

  Logger.log('--- 商品マスタの状態 ---');
  Logger.log('読み込んだ行数: ' + products.length);

  const noKeyword = [];
  const noCapacity = [];
  const noProtein = [];
  const noFlavor = [];
  const noBrand = [];
  const noMethod = [];

  products.forEach(function (product) {
    if (!product.keyword) {
      noKeyword.push(product.productId);
    }
    if (!product.capacity) {
      noCapacity.push(product.productId);
    }
    if (!product.totalProtein) {
      noProtein.push(product.productId);
    }
    if (!product.flavor) {
      noFlavor.push(product.productId);
    }
    if (!product.brand) {
      noBrand.push(product.productId);
    }
    if (!product.method) {
      noMethod.push(product.productId);
    }
  });

  if (noKeyword.length > 0) {
    Logger.log('検索キーワード未入力 ' + noKeyword.length + '件: ' + noKeyword.join(', '));
  }

  if (noCapacity.length > 0) {
    Logger.log('容量g 未入力 ' + noCapacity.length + '件: ' + noCapacity.join(', '));
  }

  if (noProtein.length > 0) {
    Logger.log('1袋のタンパク質が計算できない ' + noProtein.length + '件: ' + noProtein.join(', '));
  }

  // 以下は止めるほどではないが、判定が1つ効かなくなるので知らせる
  if (noFlavor.length > 0) {
    Logger.log('味 未入力 ' + noFlavor.length + '件（味の照合が効きません）: ' + noFlavor.join(', '));
  }

  if (noBrand.length > 0) {
    Logger.log('ブランド 未入力 ' + noBrand.length + '件（別ブランド除外が効きません）: ' + noBrand.join(', '));
  }

  if (noMethod.length > 0) {
    Logger.log('製法 未入力 ' + noMethod.length + '件（別ライン除外が効きません）: ' + noMethod.join(', '));
  }

  if (noKeyword.length === 0 && noCapacity.length === 0 && noProtein.length === 0 &&
      noFlavor.length === 0 && noBrand.length === 0 && noMethod.length === 0) {
    Logger.log('欠けている項目はありません。');
  }

  return '商品マスタの点検が終わりました。実行ログを確認してください。';
}

/**
 * 1商品だけを詳しく調べる。
 * ファイル冒頭の DIAGNOSE_TARGET_ID を書き換えてから実行する。
 *
 * 本番と同じ件数（FETCH_HITS × FETCH_PAGES）を取り、
 * 1件ずつ「商品名 / 価格 / 判定」をログに出す。
 * 「採用できる結果が0件」の原因を目で確かめるための関数。
 *
 * 価格ログには一切書き込まない。
 */
function diagnoseProduct(productId) {
  const targetId = String(productId || DIAGNOSE_TARGET_ID).trim();

  if (!targetId) {
    throw new Error('調べたい商品IDを DIAGNOSE_TARGET_ID に書いてください。');
  }

  const credentials = getCredentials_();
  const products = readMaster_(false);

  let product = null;

  for (let i = 0; i < products.length; i++) {
    if (products[i].productId === targetId) {
      product = products[i];
      break;
    }
  }

  if (!product) {
    throw new Error('商品マスタに見つかりません: ' + targetId);
  }

  Logger.log('--- 対象商品 ---');
  Logger.log('商品ID: ' + product.productId);
  Logger.log('表示名: ' + buildDisplayName_(product));
  Logger.log('ブランド: ' + (product.brand || '(未入力)'));
  Logger.log('味: ' + (product.flavor || '(未入力)'));
  Logger.log('製法: ' + (product.method || '(未入力)'));
  Logger.log('形態: ' + product.form);
  Logger.log('容量: ' + (product.capacity === null ? '(未入力)' : product.capacity + 'g'));
  Logger.log('1食あたり: ' + (product.servingSize === null ? '(未入力)' : product.servingSize + 'g'));
  Logger.log('タンパク質/食: ' + (product.proteinPerServing === null ? '(未入力)' : product.proteinPerServing + 'g'));
  Logger.log('1袋のタンパク質: ' + (product.totalProtein === null ? '(計算できない)' : Math.round(product.totalProtein) + 'g'));
  Logger.log('ステータス: ' + product.status);
  Logger.log('検索キーワード: ' + (product.keyword || '(未入力)'));

  if (!product.keyword) {
    return '検索キーワードが未入力です。マスタに入れてから再実行してください。';
  }

  const items = searchRakuten_(credentials, product.keyword, CONFIG.FETCH_HITS, {
    pages: CONFIG.FETCH_PAGES,
    ngKeyword: buildNgKeyword_(product.form)
  });

  Logger.log('--- 検索結果 ' + items.length + '件 ---');

  if (items.length === 0) {
    Logger.log('楽天がこのキーワードで何も返しませんでした。キーワードを見直してください。');
    return 'ヒット0件でした。検索キーワードを見直してください。';
  }

  const reasons = {};
  let okCount = 0;

  items.forEach(function (item, index) {
    const evaluated = evaluateItem_(product, item);
    const verdict = evaluated.rejectReason || '★採用可';

    if (evaluated.rejectReason) {
      reasons[evaluated.rejectReason] = (reasons[evaluated.rejectReason] || 0) + 1;
    } else {
      okCount++;
    }

    Logger.log(
      (index + 1) + '位 | ' + item.itemPrice + '円 | ' +
      (evaluated.pricePer20g === null ? '20g単価-' : '20g ' + evaluated.pricePer20g + '円') + ' | ' +
      verdict +
      '\n      ' + item.cleanName +
      '\n      ショップ: ' + item.shopName +
      '\n      名前から読めた容量: ' + (extractAllSizes_(item.cleanName).join(' / ') || '(なし)')
    );
  });

  Logger.log('--- 集計 ---');
  Logger.log('採用可: ' + okCount + '件');

  Object.keys(reasons).forEach(function (reason) {
    Logger.log(reason + ': ' + reasons[reason] + '件');
  });

  return targetId + ' の診断が終わりました。実行ログを確認してください。';
}

/**
 * 検索テスト。
 * 商品マスタの全行について、楽天の検索結果 上位N件をそのまま並べる。
 * 除外判定の結果も列に出すので、フィルタが効きすぎていないか確認できる。
 * 価格ログには一切書き込まない。
 */
function runSearchTest() {
  const credentials = getCredentials_();
  const products = readMaster_(false);

  if (products.length === 0) {
    throw new Error('商品マスタに行がありません。シート名の設定を確認してください: ' + CONFIG.MASTER_SHEET_NAME);
  }

  const rows = [];
  const errors = [];

  products.forEach(function (product) {
    if (!product.keyword) {
      rows.push([
        product.productId, buildDisplayName_(product), product.form,
        '(検索キーワード未入力)', '', '', '', '', '', '', '', '', '', ''
      ]);
      return;
    }

    let items;
    try {
      items = searchRakuten_(credentials, product.keyword, CONFIG.TEST_HITS, {
        pages: CONFIG.TEST_PAGES,
        ngKeyword: buildNgKeyword_(product.form)
      });
    } catch (e) {
      errors.push(product.productId + ': ' + e.message);
      rows.push([
        product.productId, buildDisplayName_(product), product.form,
        product.keyword, '', 'エラー: ' + e.message, '', '', '', '', '', '', '', ''
      ]);
      Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
      return;
    }

    if (items.length === 0) {
      rows.push([
        product.productId, buildDisplayName_(product), product.form,
        product.keyword, '', '(ヒット0件)', '', '', '', '', '', '', '', ''
      ]);
    } else {
      items.forEach(function (item, index) {
        const evaluated = evaluateItem_(product, item);

        rows.push([
          product.productId,
          buildDisplayName_(product),
          product.form,
          product.keyword,
          index + 1,
          item.cleanName,
          item.shopName,
          item.itemPrice,
          item.postage,
          evaluated.quantity === null ? '' : evaluated.quantity,
          evaluated.pricePerUnit === null ? '' : evaluated.pricePerUnit,
          evaluated.pricePer20g === null ? '' : evaluated.pricePer20g,
          evaluated.rejectReason || '採用可',
          evaluated.matchNote
        ]);
      });
    }

    Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
  });

  const header = [
    '商品ID', '表示名', '形態', '検索キーワード', '順位',
    '楽天での商品名', 'ショップ名', '価格', '送料', '入数',
    '1本あたり', '20gあたり', '判定', '照合した条件'
  ];

  writeSheet_(CONFIG.TEST_SHEET_NAME, header, rows);

  const message = '検索テスト完了: ' + products.length + '商品 / ' + rows.length + '行' +
    (errors.length > 0 ? '\nエラー ' + errors.length + '件:\n' + errors.slice(0, 5).join('\n') : '');
  Logger.log(message);
  return message;
}

/**
 * キーワード検証シートを用意する。
 * 既にあれば作らない。中身は消さない。
 */
function setupKeywordTest() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(CONFIG.KEYWORD_INPUT_SHEET_NAME);

  if (sheet) {
    Logger.log('シートは既にあります: ' + CONFIG.KEYWORD_INPUT_SHEET_NAME);
    return 'シートは既にあります。A列に商品ID（任意）、B列に試したいキーワードを入れてください。';
  }

  sheet = spreadsheet.insertSheet(CONFIG.KEYWORD_INPUT_SHEET_NAME);

  const header = ['商品ID（任意）', '試したい検索キーワード', 'メモ'];
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 360);
  sheet.setColumnWidth(3, 240);

  const examples = [
    ['valx-whey-choco-1000', 'VALX ホエイプロテイン 1kg チョコレート', '商品IDありで実行するとブランドと製法まで照合される'],
    ['', 'VALX ホエイプロテイン 1kg チョコレート', '商品IDなし。キーワードから容量と味を推定して判定する'],
    ['', 'グロング ホエイプロテイン100 ベーシック 1kg', '容量が合わない結果が除外されるか見る']
  ];

  sheet.getRange(2, 1, examples.length, 3).setValues(examples);

  Logger.log('シートを作りました: ' + CONFIG.KEYWORD_INPUT_SHEET_NAME);
  return 'キーワード検証シートを作りました。B列にキーワードを追記して runKeywordTest を実行してください。';
}

/**
 * キーワード検証。
 * 「キーワード検証」シートのB列に書いたキーワードで検索し、
 * 結果を「キーワード検証結果」シートに並べる。
 *
 * 商品マスタは読むだけで書き換えない。価格ログにも書かない。
 *
 * A列に商品IDを入れておくと、その商品として評価（除外判定・単価計算）した結果が出る。
 * A列が空のときは、キーワード自身から容量・形態・味を推定して照合する。
 * 推定できた内容は「照合した条件」列に出るので、何と比べた結果なのかが分かる。
 *
 * 以前は商品IDがないと容量照合もパウダー除外も走らず、
 * 1kgで検索して500gが返っても「採用可」と出ていた。
 */
function runKeywordTest() {
  const credentials = getCredentials_();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const inputSheet = spreadsheet.getSheetByName(CONFIG.KEYWORD_INPUT_SHEET_NAME);

  if (!inputSheet) {
    throw new Error('シートがありません。先に setupKeywordTest を実行してください: ' + CONFIG.KEYWORD_INPUT_SHEET_NAME);
  }

  const inputValues = inputSheet.getDataRange().getValues();

  if (inputValues.length < 2) {
    throw new Error('キーワードが入力されていません。B列に試したいキーワードを入れてください。');
  }

  // 商品マスタを商品IDで引けるようにしておく
  const masterMap = {};
  readMaster_(false).forEach(function (product) {
    masterMap[product.productId] = product;
  });

  const rows = [];

  for (let i = 1; i < inputValues.length; i++) {
    const productId = String(inputValues[i][0]).trim();
    const keyword = String(inputValues[i][1]).trim();

    if (!keyword) {
      continue;
    }

    // 商品IDが指定されていればその商品として評価する。
    // 指定がなければキーワードから容量・形態・味を推定した仮商品として評価する。
    const product = masterMap[productId] || buildProductFromKeyword_(keyword, productId);

    let items;
    try {
      items = searchRakuten_(credentials, keyword, CONFIG.TEST_HITS, {
        pages: CONFIG.TEST_PAGES,
        ngKeyword: buildNgKeyword_(product.form)
      });
    } catch (e) {
      rows.push([keyword, product.productId, '', 'エラー: ' + e.message, '', '', '', '', '', '']);
      Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
      continue;
    }

    if (items.length === 0) {
      rows.push([keyword, product.productId, '', '(ヒット0件)', '', '', '', '', '', describeProduct_(product)]);
    } else {
      items.forEach(function (item, index) {
        const evaluated = evaluateItem_(product, item);

        rows.push([
          keyword,
          product.productId,
          index + 1,
          item.cleanName,
          item.itemPrice,
          item.postage,
          item.shopName,
          evaluated.pricePer20g === null ? '' : evaluated.pricePer20g,
          evaluated.rejectReason || '採用可',
          evaluated.matchNote || describeProduct_(product)
        ]);
      });
    }

    Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
  }

  const header = [
    '検索キーワード', '商品ID', '順位', '楽天での商品名',
    '価格', '送料', 'ショップ名', '20gあたり', '判定', '照合した条件'
  ];

  writeSheet_(CONFIG.KEYWORD_RESULT_SHEET_NAME, header, rows);

  const message = 'キーワード検証完了: ' + rows.length + '行';
  Logger.log(message);
  return message;
}

/**
 * 商品画像の確認。
 * 各商品について、採用候補の上位数件の画像をシートに並べる。
 * IMAGE関数で埋め込むので、シートを開けばそのまま目で見て判断できる。
 *
 * マスタも価格ログも書き換えない。
 */
function collectImages() {
  const credentials = getCredentials_();
  const products = readMaster_(false);

  if (products.length === 0) {
    throw new Error('商品マスタに行がありません。');
  }

  const rows = [];

  products.forEach(function (product) {
    if (!product.keyword) {
      return;
    }

    let items;
    try {
      items = searchRakuten_(credentials, product.keyword, CONFIG.TEST_HITS, {
        pages: CONFIG.TEST_PAGES,
        ngKeyword: buildNgKeyword_(product.form)
      });
    } catch (e) {
      rows.push([product.productId, buildDisplayName_(product), '', '', 'エラー: ' + e.message, '', '']);
      Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
      return;
    }

    // 除外されない候補を優先し、足りなければ除外されたものも見せる
    const ok = [];
    const ng = [];

    items.forEach(function (item) {
      const evaluated = evaluateItem_(product, item);
      (evaluated.rejectReason ? ng : ok).push({ item: item, reason: evaluated.rejectReason });
    });

    const picked = ok.concat(ng).slice(0, CONFIG.IMAGE_CANDIDATES);

    if (picked.length === 0) {
      rows.push([product.productId, buildDisplayName_(product), '', '', '(ヒット0件)', '', '']);
    } else {
      picked.forEach(function (p, index) {
        rows.push([
          product.productId,
          buildDisplayName_(product),
          index + 1,
          p.item.imageUrl ? '=IMAGE("' + p.item.imageUrl + '",1)' : '(画像なし)',
          p.item.cleanName,
          p.item.shopName,
          p.reason || '採用可'
        ]);
      });
    }

    Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
  });

  const header = ['商品ID', '表示名', '順位', '画像', '楽天での商品名', 'ショップ名', '判定'];

  writeSheet_(CONFIG.IMAGE_CHECK_SHEET_NAME, header, rows);

  // 画像が潰れないよう行の高さと列幅を広げる
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.IMAGE_CHECK_SHEET_NAME);

  if (sheet && rows.length > 0) {
    sheet.setRowHeights(2, rows.length, 110);
    sheet.setColumnWidth(4, 130);
    sheet.setColumnWidth(5, 380);
    sheet.setColumnWidth(2, 200);
  }

  const message = '画像確認シートを作りました: ' + rows.length + '行';
  Logger.log(message);
  return message;
}

/**
 * 本番の価格取得。
 * ステータスが「公開」の商品だけを対象に、採用できる結果を1件選んで価格ログへ追記する。
 * 既存の行は消さない。毎日追記していくことで価格推移が溜まる。
 *
 * 0件になった商品については、どの除外条件で何件落ちたかを添えてログに出す。
 * 「採用できる結果が0件」だけでは、キーワードを直すのか容量を直すのか判断できないため。
 */
function runPriceFetch() {
  const credentials = getCredentials_();
  const products = readMaster_(true);

  if (products.length === 0) {
    Logger.log('ステータスが「公開」の商品がありません。処理を終了します。');
    return 'ステータス「公開」の商品が0件のため、何も取得しませんでした。';
  }

  const timestamp = new Date();
  const rows = [];
  const skipped = [];

  products.forEach(function (product) {
    if (!product.keyword) {
      skipped.push(product.productId + ': 検索キーワード未入力');
      return;
    }

    let items;
    try {
      items = searchRakuten_(credentials, product.keyword, CONFIG.FETCH_HITS, {
        pages: CONFIG.FETCH_PAGES,
        ngKeyword: buildNgKeyword_(product.form)
      });
    } catch (e) {
      skipped.push(product.productId + ': ' + e.message);
      Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
      return;
    }

    const candidates = [];
    const reasons = {};

    items.forEach(function (item) {
      const evaluated = evaluateItem_(product, item);

      if (!evaluated.rejectReason) {
        candidates.push({ item: item, evaluated: evaluated });
      } else {
        reasons[evaluated.rejectReason] = (reasons[evaluated.rejectReason] || 0) + 1;
      }
    });

    if (candidates.length === 0) {
      skipped.push(
        product.productId + ': 採用できる結果が0件 ' +
        summarizeReasons_(reasons, items.length)
      );
      Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
      return;
    }

    const best = selectBest_(product, candidates);

    rows.push([
      product.productId,
      '楽天市場',
      product.form,
      best.item.itemPrice,
      best.item.postage,
      best.evaluated.quantity === null ? '' : best.evaluated.quantity,
      best.evaluated.pricePerUnit === null ? '' : best.evaluated.pricePerUnit,
      best.evaluated.pricePer20g === null ? '' : best.evaluated.pricePer20g,
      timestamp,
      best.item.itemUrl,
      best.item.imageUrl,
      best.item.cleanName,
      best.item.shopName
    ]);

    Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
  });

  const header = [
    '商品ID', 'モール', '形態', '価格', '送料', '入数', '1本あたり', '20gあたり',
    '取得日時', 'URL', '画像URL', '楽天での商品名', 'ショップ名'
  ];

  appendToSheet_(CONFIG.PRICE_LOG_SHEET_NAME, header, rows);

  const message = '価格取得完了: ' + rows.length + '件を追記' +
    (skipped.length > 0 ? '\nスキップ ' + skipped.length + '件:\n' + skipped.join('\n') : '');
  Logger.log(message);
  return message;
}

/**
 * 毎日の自動実行を設定する（毎朝6時台）。
 * 既存の同名トリガーは削除してから作り直す。
 */
function createDailyTrigger() {
  deleteDailyTrigger();

  ScriptApp.newTrigger('runPriceFetch')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .create();

  Logger.log('毎日6時台の自動実行を設定しました。');
  return '毎日6時台の自動実行を設定しました。';
}

/**
 * 自動実行を解除する。
 */
function deleteDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let count = 0;

  triggers.forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'runPriceFetch') {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  });

  Logger.log('自動実行を ' + count + '件 解除しました。');
  return '自動実行を ' + count + '件 解除しました。';
}

// ============================================================
// 判定ロジック
// ============================================================

/**
 * 検索結果1件を商品マスタの情報と突き合わせて評価する。
 *
 * 戻り値:
 *   quantity      … RTDの入数（抽出できなければ null）
 *   pricePerUnit  … RTDの1本あたり価格（同上）
 *   pricePer20g   … タンパク質20gあたりの価格（計算できなければ null）
 *   rejectReason  … 除外する理由。空文字なら採用可
 *   matchNote     … 何と照合した結果なのか（シートで目視確認するため）
 *
 * 判定の順番には意味がある。
 * ショップ名・ブランド・選択制を先に落とさないと、
 * 容量と味がたまたま一致して通り抜ける。
 */
function evaluateItem_(product, item) {
  const result = {
    quantity: null,
    pricePerUnit: null,
    pricePer20g: null,
    rejectReason: '',
    matchNote: ''
  };

  const name = item.cleanName;
  const notes = [];

  // --- 1. ショップ名による除外（ふるさと納税） ---
  // 自治体の出品は商品名に「ふるさと納税」と書かれないことがある。
  // 「千葉県富津市」のように、ショップ名が自治体名そのものになっている。
  if (CONFIG.STRICT.SHOP_MUNICIPALITY && isMunicipalityShop_(item.shopName)) {
    result.rejectReason = '除外: 自治体の出品（ふるさと納税の疑い）';
    return result;
  }

  // --- 2. 形態を問わない除外（商品名） ---
  const commonHit = findKeyword_(name, COMMON_EXCLUDE_KEYWORDS);
  if (commonHit) {
    result.rejectReason = '除外: ' + commonHit;
    return result;
  }

  // --- 3. 別ブランドの除外 ---
  // 「バルクス」で バルクスポーツ が返るような取り違えを防ぐ。
  if (CONFIG.STRICT.BRAND_NG && product.brand) {
    const brandHit = findBrandNg_(product.brand, name);

    if (brandHit) {
      result.rejectReason = '除外: 別ブランド（' + brandHit + '）';
      return result;
    }

    notes.push('ブランド:' + product.brand);
  }

  // --- 4. 別ラインの除外 ---
  // 同じブランドでも、ザバスの Shape&Beauty のように
  // 容量も味も同じで中身が違うラインがある。
  if (CONFIG.STRICT.SERIES_NG && product.series) {
    const seriesHit = findSeriesNg_(product.series, name);

    if (seriesHit) {
      result.rejectReason = '除外: 別ライン（' + seriesHit + '）';
      return result;
    }
  }

  // WPCの行にWPI（アイソレート）が入るのを防ぐ。
  if (CONFIG.STRICT.METHOD_CONFLICT && product.method) {
    const methodHit = findMethodConflict_(product.method, name);

    if (methodHit) {
      result.rejectReason = '除外: 別ライン（' + methodHit + '）';
      return result;
    }

    notes.push('製法:' + product.method);
  }

  // --- 5. 味が選択制の商品ページを除外 ---
  // 「8種類の味から選べる」「フレーバーおまかせ」は
  // APIが返す代表価格が単品価格と一致しない。
  if (CONFIG.STRICT.MULTI_FLAVOR) {
    const multiHit = detectMultiFlavor_(name);

    if (multiHit) {
      result.rejectReason = '除外: 味が選択制（' + multiHit + '）';
      return result;
    }
  }

  // --- 6. 味の照合 ---
  if (CONFIG.STRICT.FLAVOR_MATCH && product.flavor) {
    const flavorMatch = matchFlavor_(name, product.flavor);

    if (flavorMatch === 'conflict') {
      result.rejectReason = '除外: 別の味が併記（別商品の疑い）';
      return result;
    }

    if (flavorMatch === 'mismatch') {
      result.rejectReason = '除外: 味が違う';
      return result;
    }

    if (flavorMatch === 'unknown') {
      if (CONFIG.STRICT.FLAVOR_REQUIRE_MATCH) {
        result.rejectReason = '除外: 味の記載なし';
        return result;
      }
    } else {
      notes.push('味:' + product.flavor);
    }
  }

  // --- 7. 形態ごとの判定 ---
  if (product.form === 'RTD') {
    const caseCount = extractCaseCount_(name);

    if (caseCount) {
      result.rejectReason = '除外: ' + caseCount + 'ケースまとめ売り';
      return result;
    }

    result.quantity = extractQuantity_(name);

    if (result.quantity === null) {
      // 入数が読めない、または多すぎるRTDは採用しない
      result.rejectReason = '除外: 入数不明または多すぎる';
      return result;
    }

    // RTDにも容量照合を入れる。
    // 200mlの行に430mlが入ると、430mlはタンパク質15gと30gが混在しているため
    // 単価が2倍ずれる。以前はここが素通りだった。
    if (CONFIG.STRICT.RTD_VOLUME && product.capacity) {
      const volumeMatch = matchCapacity_(name, product.capacity);

      if (volumeMatch === 'mismatch') {
        result.rejectReason = '除外: 容量が違う';
        return result;
      }

      if (volumeMatch === 'unknown' && CONFIG.STRICT.RTD_REQUIRE_VOLUME) {
        result.rejectReason = '除外: 容量の記載なし';
        return result;
      }

      if (volumeMatch === 'ok') {
        notes.push('容量:' + product.capacity);
      }
    }

    result.pricePerUnit = Math.round(item.itemPrice / result.quantity);

    // 1本あたりの、タンパク質20gあたり価格。
    // RTDは容量＝1食分なので totalProtein は1本のタンパク質量と等しい。
    // 以前はここが空欄のまま価格ログに書かれていた。
    if (product.totalProtein) {
      result.pricePer20g = Math.round(result.pricePerUnit / product.totalProtein * 20 * 10) / 10;
    }

    notes.push('入数:' + result.quantity);
    result.matchNote = notes.join(' / ');
    return result;
  }

  // パウダーは小分け・セットを除外する
  if (product.form === 'パウダー') {
    const powderHit = findKeyword_(name, POWDER_EXCLUDE_KEYWORDS);
    if (powderHit) {
      result.rejectReason = '除外: ' + powderHit;
      return result;
    }
  }

  // 複数袋のまとめ売りは1袋の価格ではないので採用しない
  const packCount = extractPackCount_(name);
  if (packCount) {
    result.rejectReason = '除外: ' + packCount + '袋まとめ売り';
    return result;
  }

  // 容量が一致するかを確かめる。
  // 単価の下限だけでは、中途半端に高い小容量品が通り抜けてしまう。
  const weightMatch = matchCapacity_(name, product.capacity);

  if (weightMatch === 'mismatch') {
    result.rejectReason = '除外: 容量が違う';
    return result;
  }

  if (weightMatch === 'unknown' && product.capacity) {
    result.rejectReason = '除外: 容量の記載なし';
    return result;
  }

  if (weightMatch === 'ok') {
    notes.push('容量:' + product.capacity);
  }

  // --- 8. 20gあたり単価の足切り ---
  if (product.totalProtein) {
    result.pricePer20g = Math.round(item.itemPrice / product.totalProtein * 20 * 10) / 10;

    if (result.pricePer20g < CONFIG.MIN_PRICE_PER_20G) {
      result.rejectReason = '除外: 単価が安すぎる（小分けの疑い）';
      return result;
    }

    if (result.pricePer20g > CONFIG.MAX_PRICE_PER_20G) {
      result.rejectReason = '除外: 単価が高すぎる（セット販売の疑い）';
      return result;
    }
  }

  result.matchNote = notes.join(' / ');
  return result;
}

/**
 * ショップ名が自治体名そのものかどうか。
 *
 * 楽天のふるさと納税の出品は、ショップ名が「千葉県富津市」「北海道白糠町」の
 * ように自治体名だけになっている。商品名からは判別できないので、ここで見る。
 *
 * 「楽天市場店」には「市」が含まれるため、単純に「市」で判定すると
 * ほとんどの正規店を巻き込んでしまう。
 * 店舗名によく出る語が含まれていたら、その時点で自治体ではないと判断する。
 */
function isMunicipalityShop_(shopName) {
  const name = String(shopName || '').trim();

  if (!name) {
    return false;
  }

  // 名前に直接書いてある場合
  if (name.indexOf('ふるさと納税') !== -1 || name.indexOf('ふるさとチョイス') !== -1) {
    return true;
  }

  // 店舗であることを示す語があれば自治体ではない
  if (/(店|ショップ|ストア|市場|商店|株式会社|有限会社|オンライン|SHOP|STORE|shop|store)/.test(name)) {
    return false;
  }

  // 自治体名にしては長すぎるものは除く
  if (name.length > 12) {
    return false;
  }

  // 「（都道府県）＋市区町村」または「市区町村」だけの形
  return /^(北海道|東京都|京都府|大阪府|.{2,3}県)?.{1,8}[市区町村]$/.test(name);
}

/**
 * ブランドに対して、混ざってはいけない語が商品名にあるか。
 * 見つかればその語を返す。なければ空文字。
 */
function findBrandNg_(brand, name) {
  const key = String(brand || '').trim();

  if (!key || !BRAND_NG_KEYWORDS[key]) {
    return '';
  }

  return findKeywordCI_(name, BRAND_NG_KEYWORDS[key]);
}

/**
 * シリーズに対して、混ざってはいけない語が商品名にあるか。
 * 見つかればその語を返す。なければ空文字。
 *
 * ブランドが同じでもラインが違う商品を弾くために使う。
 * ザバスの Shape&Beauty は MILK PROTEIN 脂肪0 と容量も味も同じだが、
 * タンパク質量が違うため、混ざると単価がずれる。
 */
function findSeriesNg_(series, name) {
  const key = String(series || '').trim();

  if (!key || !SERIES_NG_KEYWORDS[key]) {
    return '';
  }

  return findKeywordCI_(name, SERIES_NG_KEYWORDS[key]);
}

/**
 * 製法に対して、矛盾する語が商品名にあるか。
 * 見つかればその語を返す。なければ空文字。
 */
function findMethodConflict_(method, name) {
  const key = String(method || '').trim().toLowerCase();

  if (!key || !METHOD_CONFLICTS[key]) {
    return '';
  }

  return findKeywordCI_(name, METHOD_CONFLICTS[key]);
}

/**
 * 商品名が「味を選ばせるページ」かどうか。
 * 該当すればその根拠を返す。なければ空文字。
 *
 * 2通りで見る。
 *   1. 「選べる」「おまかせ」など、選択制であることを示す語がある
 *   2. 味の名前が閾値以上の種類だけ並んでいる
 */
function detectMultiFlavor_(name) {
  const marker = findKeyword_(name, MULTI_FLAVOR_MARKERS);

  if (marker) {
    return marker;
  }

  // 長い語から順に消しながら数える。
  // そうしないと「ストロベリー」が「ベリー」にも当たって2種類と数えてしまう。
  const sorted = FLAVOR_TOKENS_FOR_COUNT.slice().sort(function (a, b) {
    return b.length - a.length;
  });

  let rest = String(name);
  let count = 0;

  sorted.forEach(function (token) {
    if (rest.indexOf(token) !== -1) {
      count++;
      rest = rest.split(token).join(' ');
    }
  });

  if (count >= CONFIG.MULTI_FLAVOR_THRESHOLD) {
    return '味' + count + '種類';
  }

  return '';
}

/**
 * マスタの味と商品名を突き合わせる。
 *
 * 戻り値:
 *   'ok'       … 一致
 *   'conflict' … 目的の味はあるが、別商品を示す語も併記されている
 *   'mismatch' … 別の味
 *   'unknown'  … 味の記載なし
 *
 * 'conflict' を分けているのは、ザバス200mlのイチゴ(15g)とストロベリー(20g)の
 * ように、ショップが検索対策で両方の語を商品名に入れる場合があるため。
 * 味の一致だけを見ると、20gの行が15gの商品を拾って単価が3割低く出る。
 */
function matchFlavor_(name, flavor) {
  const aliases = flavorAliases_(flavor);

  if (aliases.length === 0) {
    return 'unknown';
  }

  const normalizedName = normalizeForMatch_(name);
  const normalizedAliases = aliases.map(normalizeForMatch_);

  let hasTarget = false;

  for (let i = 0; i < normalizedAliases.length; i++) {
    if (normalizedName.indexOf(normalizedAliases[i]) !== -1) {
      hasTarget = true;
      break;
    }
  }

  // 別商品を示す語が併記されていないか。
  // 目的の味があっても、こちらがあれば別商品を疑う。
  const conflicts = FLAVOR_CONFLICTS[flavorKey_(flavor)];

  if (conflicts) {
    for (let i = 0; i < conflicts.length; i++) {
      if (normalizedName.indexOf(normalizeForMatch_(conflicts[i])) !== -1) {
        // 目的の味が無いなら、ただの別商品。理由を分けておく。
        return hasTarget ? 'conflict' : 'mismatch';
      }
    }
  }

  if (hasTarget) {
    return 'ok';
  }

  // 目的の味は無い。別の味が書いてあるなら別商品と判断する。
  //
  // 数え上げ用の配列（FLAVOR_TOKENS_FOR_COUNT）だけでは足りない。
  // 「プレーン」「ナチュラル」はそこに入れていないため、
  // チョコレートの行にプレーンが来ても「記載なし」になってしまう。
  // 表記ゆれの一覧そのものを引いて、別の味かどうかを見る。
  const keys = Object.keys(FLAVOR_ALIASES);

  for (let i = 0; i < keys.length; i++) {
    const others = FLAVOR_ALIASES[keys[i]];

    for (let j = 0; j < others.length; j++) {
      const token = normalizeForMatch_(others[j]);

      // 目的の味と同じ表記は数えない（ミルクチョコとチョコレートなど）
      if (normalizedAliases.indexOf(token) !== -1) {
        continue;
      }

      if (normalizedName.indexOf(token) !== -1) {
        return 'mismatch';
      }
    }
  }

  for (let i = 0; i < FLAVOR_TOKENS_FOR_COUNT.length; i++) {
    const token = normalizeForMatch_(FLAVOR_TOKENS_FOR_COUNT[i]);

    if (normalizedAliases.indexOf(token) !== -1) {
      continue;
    }

    if (normalizedName.indexOf(token) !== -1) {
      return 'mismatch';
    }
  }

  return 'unknown';
}

/**
 * マスタの味から、接尾語を落とした引き当て用のキーを作る。
 * FLAVOR_ALIASES と FLAVOR_CONFLICTS はこのキーで引く。
 */
function flavorKey_(flavor) {
  return String(flavor || '')
    .trim()
    .replace(/(風味|テイスト|フレーバー|味)$/, '')
    .replace(/[\s\u3000]+/g, '')
    .trim();
}

/**
 * マスタの味の値から、商品名で使われうる表記の一覧を作る。
 * 「味」「風味」「フレーバー」などの接尾語は落としてから引く。
 *
 * 末尾が「微糖」などの場合は、それを外した形も候補に入れる。
 * ショップが「マイルドカカオ微糖」を「マイルドカカオ」としか書かないため。
 */
function flavorAliases_(flavor) {
  const raw = String(flavor || '').trim();

  if (!raw) {
    return [];
  }

  const normalized = flavorKey_(raw);

  if (!normalized) {
    return [];
  }

  let aliases;

  if (FLAVOR_ALIASES[normalized]) {
    aliases = FLAVOR_ALIASES[normalized].slice();
  } else if (FLAVOR_ALIASES[raw]) {
    aliases = FLAVOR_ALIASES[raw].slice();
  } else {
    // 一覧に無い味は、その語そのものを探す
    aliases = [normalized];
  }

  // 「微糖」などを外した形も一致とみなす
  for (let i = 0; i < OPTIONAL_FLAVOR_SUFFIXES.length; i++) {
    const suffix = OPTIONAL_FLAVOR_SUFFIXES[i];

    if (normalized.length > suffix.length &&
        normalized.slice(-suffix.length) === suffix) {
      const base = normalized.slice(0, normalized.length - suffix.length);

      if (base && aliases.indexOf(base) === -1) {
        aliases.push(base);
      }
    }
  }

  return aliases;
}

/**
 * 商品名の容量が、マスタの容量と一致するか。
 * パウダー（g / kg）とRTD（ml / cc / L）の両方を見る。
 *
 * 戻り値: 'ok' 一致 / 'mismatch' 別容量 / 'unknown' 記載なし
 *
 * 記載が無いものを 'ok' にすると、何グラムか分からないまま
 * 単価を計算することになるので、必ず区別する。
 *
 * 飲料は 1ml をおよそ 1g として扱う。
 * マスタの「容量g」にmlの数値を入れている運用に合わせている。
 */
function matchCapacity_(name, capacity) {
  if (!capacity) {
    return 'unknown';
  }

  const sizes = extractAllSizes_(name);

  if (sizes.length === 0) {
    return 'unknown';
  }

  const tolerance = Math.max(CONFIG.WEIGHT_TOLERANCE_MIN, capacity * CONFIG.WEIGHT_TOLERANCE_RATIO);

  for (let i = 0; i < sizes.length; i++) {
    if (Math.abs(sizes[i] - capacity) <= tolerance) {
      return 'ok';
    }
  }

  return 'mismatch';
}

/**
 * 旧関数名の互換。他ファイルから呼ばれていても動くように残してある。
 */
function matchWeight_(name, capacity) {
  return matchCapacity_(name, capacity);
}

/**
 * 商品名に書かれている容量をすべて拾う。
 * 重さ（g / kg）と容量（ml / cc / L）の両方を、g換算の数値で返す。
 */
function extractAllSizes_(name) {
  return extractWeights_(name).concat(extractVolumes_(name));
}

/**
 * 商品名に書かれている重さをすべて拾う（グラム換算）。
 * 「1000g」「1kg」「2.27kg」「1,000g」などに対応する。
 */
function extractWeights_(name) {
  const found = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(kg|g)(?![a-z])/gi;
  let m;

  while ((m = re.exec(String(name))) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''));

    if (!isFinite(value) || value <= 0) continue;

    const grams = m[2].toLowerCase() === 'kg' ? value * 1000 : value;
    found.push(grams);
  }

  return found;
}

/**
 * 商品名に書かれている容量をすべて拾う（ml換算）。
 * 「430ml」「1リットル」「200cc」などに対応する。
 *
 * 単独の半角「L」は「XL」「4L」など別の意味で使われることがあるので見ない。
 * ドリンクの商品名はほぼ ml 表記なので、それで足りる。
 */
function extractVolumes_(name) {
  const found = [];
  const text = String(name);
  let m;

  const mlRe = /(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|Ml|cc|ミリリットル)/g;

  while ((m = mlRe.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (isFinite(value) && value > 0) {
      found.push(value);
    }
  }

  const literRe = /(\d+(?:[.,]\d+)?)\s*(リットル|ℓ|Ｌ)/g;

  while ((m = literRe.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (isFinite(value) && value > 0) {
      found.push(value * 1000);
    }
  }

  return found;
}

/**
 * 商品名から入数を抽出する。
 * 「430ml×12本」「24本入り」「12本セット」などの表記に対応する。
 * 誤抽出を避けるため、範囲外の数値は採用しない。
 *
 * 「本」だけでなく「個」「パック」「缶」も見る。
 * ザバス ミルクプロテインの200ml紙パックは、楽天では
 * 「プロテイン15g 3個」「6個」「12個」の形で売られていて、
 * 「本」だけを見ていた頃はこれが全部「入数不明」で落ちていた。
 *
 * 「紙パック」は数字が前に付かないので、数字を必須にしている
 * このパターンには当たらない。
 */
function extractQuantity_(name) {
  const patterns = [
    /(\d+)\s*本入/,
    /[×xX＊*]\s*(\d+)\s*本/,
    /(\d+)\s*本\s*セット/,
    /(\d+)\s*本/,
    /(\d+)\s*個入/,
    /[×xX＊*]\s*(\d+)\s*個/,
    /(\d+)\s*個\s*セット/,
    /(\d+)\s*個/,
    /(\d+)\s*缶入/,
    /[×xX＊*]\s*(\d+)\s*缶/,
    /(\d+)\s*缶/,
    /(\d+)\s*パック入/,
    /[×xX＊*]\s*(\d+)\s*パック/,
    /(\d+)\s*パック\s*セット/,
    /[×xX＊*]\s*(\d+)(?!\d)/
  ];

  for (let i = 0; i < patterns.length; i++) {
    const matched = name.match(patterns[i]);

    if (matched) {
      const value = parseInt(matched[1], 10);

      if (value >= CONFIG.MIN_QUANTITY && value <= CONFIG.MAX_QUANTITY) {
        return value;
      }
    }
  }

  return null;
}

/**
 * 商品名から「複数ケース」を読み取る。
 * 「2ケース」「3ケース選べる」など。1ケースは対象外。
 *
 * 入数の抽出だけだと「240ml×24本×2ケース」で24を拾ってしまい、
 * 実際の48本と食い違うので、ケース数を別に見る。
 */
function extractCaseCount_(name) {
  const matched = String(name).match(/(\d+)\s*ケース/);

  if (matched) {
    const value = parseInt(matched[1], 10);
    if (value >= 2 && value <= 20) return value;
  }

  return null;
}

/**
 * 商品名から「複数袋まとめ売り」を読み取る。
 * 「1kg×3袋」「2袋セット」など。1袋は対象外。
 */
function extractPackCount_(name) {
  const patterns = [
    /[×xX＊*]\s*(\d+)\s*袋/,
    /(\d+)\s*袋\s*セット/,
    /(\d+)\s*個\s*セット/
  ];

  for (let i = 0; i < patterns.length; i++) {
    const matched = String(name).match(patterns[i]);

    if (matched) {
      const value = parseInt(matched[1], 10);
      if (value >= 2 && value <= 30) return value;
    }
  }

  return null;
}

/**
 * 商品名から店舗の販促文言を取り除く。
 * 【最大10万P当選★要エントリー★8/20〜8/31】のような、
 * 時期が来れば消える文字列をそのまま保存しないための処理。
 */
function cleanItemName_(name) {
  return String(name)
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/［[^］]*］/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 文字列に含まれる最初の該当キーワードを返す。含まなければ空文字。
 */
function findKeyword_(text, keywords) {
  for (let i = 0; i < keywords.length; i++) {
    if (text.indexOf(keywords[i]) !== -1) {
      return keywords[i];
    }
  }

  return '';
}

/**
 * 照合用に文字列をそろえる。
 * 全角英数と記号を半角にし、空白を取り除き、大文字にする。
 *
 * 楽天の商品名は表記が揺れる。
 *   「ヘーゼルナッツ＆チョコ」と「ヘーゼルナッツ&チョコ」
 *   「コーヒー微糖」と「＜コーヒー 微糖＞」
 * これらを同じものとして扱わないと、正しい商品を取りこぼす。
 */
function normalizeForMatch_(text) {
  return String(text)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    })
    .replace(/＆/g, '&')
    .replace(/／/g, '/')
    .replace(/＜/g, '<')
    .replace(/＞/g, '>')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[\s\u3000・･]+/g, '')
    .toUpperCase();
}

/**
 * 大文字小文字・全角半角・空白を区別せずに探す版。
 * 「WPI」と「wpi」、「HALEO」と「Haleo」、
 * 「Shape&Beauty」と「Shape＆Beauty」を同じものとして扱う。
 */
function findKeywordCI_(text, keywords) {
  const normalizedText = normalizeForMatch_(text);

  for (let i = 0; i < keywords.length; i++) {
    if (normalizedText.indexOf(normalizeForMatch_(keywords[i])) !== -1) {
      return keywords[i];
    }
  }

  return '';
}

/**
 * 除外理由の集計を、ログ1行に収まる文字列にまとめる。
 * 件数の多い順に最大4種類まで並べる。
 */
function summarizeReasons_(reasons, totalHits) {
  const keys = Object.keys(reasons);

  if (keys.length === 0) {
    return '（検索' + totalHits + '件 / 除外理由なし＝ヒット自体が0件）';
  }

  keys.sort(function (a, b) {
    return reasons[b] - reasons[a];
  });

  const parts = keys.slice(0, 4).map(function (key) {
    return key + ' ' + reasons[key] + '件';
  });

  return '（検索' + totalHits + '件 / ' + parts.join('、') + '）';
}

/**
 * 採用候補から1件を選ぶ。
 * RTDは1本あたりが最安のもの、それ以外は総額が最安のもの。
 */
function selectBest_(product, candidates) {
  if (product.form === 'RTD') {
    return candidates.reduce(function (min, current) {
      return current.evaluated.pricePerUnit < min.evaluated.pricePerUnit ? current : min;
    }, candidates[0]);
  }

  return candidates.reduce(function (min, current) {
    return current.item.itemPrice < min.item.itemPrice ? current : min;
  }, candidates[0]);
}

// ============================================================
// キーワードから商品情報を推定する（キーワード検証用）
// ============================================================

/**
 * 商品IDが指定されていないキーワード検証行のために、
 * キーワード自身から容量・形態・味を推定した仮の商品を作る。
 *
 * これが無いと、容量照合もパウダー除外も走らないまま
 * 全件が「採用可」と出て、テストの意味が無くなる。
 *
 * ブランドと製法は推定しない。
 * 「バルクス」がVALXなのかバルクスポーツなのかは文字列からは決められないので、
 * 推測で除外するより、判定を効かせないほうが誤解が少ない。
 * ブランドの取り違えまで確かめたいときは、A列に商品IDを入れて実行する。
 */
function buildProductFromKeyword_(keyword, productId) {
  const weights = extractWeights_(keyword);
  const volumes = extractVolumes_(keyword);

  let form = '';
  let capacity = null;

  if (volumes.length > 0) {
    form = 'RTD';
    capacity = volumes[0];
  } else if (weights.length > 0) {
    form = 'パウダー';
    capacity = weights[0];
  }

  // 「本」が入っていればドリンクとみなす
  if (!form && /\d+\s*本/.test(keyword)) {
    form = 'RTD';
  }

  return {
    productId: productId || '(未指定)',
    brand: '',
    series: '',
    flavor: detectFlavorInText_(keyword),
    method: '',
    form: form,
    capacity: capacity,
    servingSize: null,
    proteinPerServing: null,
    keyword: keyword,
    status: '',
    totalProtein: null,
    inferred: true
  };
}

/**
 * 文字列に含まれる味の名前を1つ返す。見つからなければ空文字。
 * キーワードから味を推定するために使う。
 */
function detectFlavorInText_(text) {
  const keys = Object.keys(FLAVOR_ALIASES);
  const upperText = String(text).toUpperCase();

  for (let i = 0; i < keys.length; i++) {
    const aliases = FLAVOR_ALIASES[keys[i]];

    for (let j = 0; j < aliases.length; j++) {
      if (upperText.indexOf(String(aliases[j]).toUpperCase()) !== -1) {
        return keys[i];
      }
    }
  }

  return '';
}

/**
 * 何と照合したのかを1行で説明する。
 * キーワード検証の結果シートで、判定の根拠を目で追えるようにするため。
 */
function describeProduct_(product) {
  const parts = [];

  if (product.form) parts.push('形態:' + product.form);
  if (product.capacity) parts.push('容量:' + product.capacity);
  if (product.flavor) parts.push('味:' + product.flavor);
  if (product.brand) parts.push('ブランド:' + product.brand);
  if (product.method) parts.push('製法:' + product.method);

  if (parts.length === 0) {
    return product.inferred ? 'キーワードから何も推定できず（共通除外のみ）' : '';
  }

  return (product.inferred ? '推定 ' : '') + parts.join(' / ');
}

// ============================================================
// 内部関数
// ============================================================

/**
 * スクリプトプロパティから認証情報を取り出す。
 * 前後の空白や改行は自動で除去する。
 */
function getCredentials_() {
  const properties = PropertiesService.getScriptProperties();
  const appId = properties.getProperty('RAKUTEN_APP_ID');
  const accessKey = properties.getProperty('RAKUTEN_ACCESS_KEY');

  if (!appId) {
    throw new Error(
      'アプリケーションIDが設定されていません。\n' +
      'GASエディタ左下の歯車（プロジェクトの設定）→ スクリプト プロパティ →\n' +
      'プロパティ名「RAKUTEN_APP_ID」に、楽天管理画面のアプリケーションID（UUID形式）を保存してください。'
    );
  }

  if (!accessKey) {
    throw new Error(
      'アクセスキーが設定されていません。\n' +
      '2026年の仕様変更で、アプリケーションIDとアクセスキーの両方が必須になりました。\n' +
      'プロパティ名「RAKUTEN_ACCESS_KEY」に、楽天管理画面のアクセスキーを保存してください。'
    );
  }

  // アフィリエイトIDは任意。未設定でも動く（通常のリンクになるだけ）。
  const affiliateId = properties.getProperty('RAKUTEN_AFFILIATE_ID');

  return {
    appId: appId.trim(),
    accessKey: accessKey.trim(),
    affiliateId: affiliateId ? affiliateId.trim() : ''
  };
}

/**
 * 商品マスタを読み込む。
 * publishedOnly が true のときはステータス「公開」の行だけを返す。
 * 容量・1食あたり・タンパク質が揃っている行には totalProtein を計算して持たせる。
 *
 * 読み込みの最後に、商品IDの重複と容量の入力ミスを点検する。
 * 商品IDが重複していると、価格ログの1行が同じIDの全行に適用され、
 * 別容量の価格が別商品のページに出てしまう（実際に起きた事故）。
 */
function readMaster_(publishedOnly) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.MASTER_SHEET_NAME);

  if (!sheet) {
    throw new Error('シートが見つかりません: ' + CONFIG.MASTER_SHEET_NAME);
  }

  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  const headerRow = values[0];
  const columnIndex = {};

  Object.keys(MASTER_COLUMNS).forEach(function (key) {
    const headerName = MASTER_COLUMNS[key];
    const index = headerRow.indexOf(headerName);

    if (index === -1) {
      throw new Error('商品マスタに列が見つかりません: ' + headerName);
    }

    columnIndex[key] = index;
  });

  // 無くても止めない列。見つからなければ -1 のままにしておく。
  const optionalIndex = {};

  Object.keys(OPTIONAL_MASTER_COLUMNS).forEach(function (key) {
    optionalIndex[key] = headerRow.indexOf(OPTIONAL_MASTER_COLUMNS[key]);
  });

  const products = [];

  // 商品IDの重複は「停止」行も含めて見る。
  // 停止中の行と公開中の行が同じIDだと、ステータスを戻した瞬間に事故が起きるため。
  const seenIds = {};
  const duplicateIds = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const productId = String(row[columnIndex.productId]).trim();

    if (!productId) {
      continue;
    }

    if (seenIds[productId]) {
      if (duplicateIds.indexOf(productId) === -1) {
        duplicateIds.push(productId + '（' + seenIds[productId] + '行目と' + (i + 1) + '行目）');
      }
    } else {
      seenIds[productId] = i + 1;
    }

    const status = String(row[columnIndex.status]).trim();

    if (status === '停止') {
      continue;
    }

    if (publishedOnly && status !== '公開') {
      continue;
    }

    const capacity = Number(row[columnIndex.capacity]);
    const servingSize = Number(row[columnIndex.servingSize]);
    const proteinPerServing = Number(row[columnIndex.proteinPerServing]);

    let totalProtein = null;

    if (capacity > 0 && servingSize > 0 && proteinPerServing > 0) {
      totalProtein = (capacity / servingSize) * proteinPerServing;
    }

    const method = optionalIndex.method >= 0
      ? String(row[optionalIndex.method]).trim()
      : '';

    products.push({
      productId: productId,
      brand: String(row[columnIndex.brand]).trim(),
      series: String(row[columnIndex.series]).trim(),
      flavor: String(row[columnIndex.flavor]).trim(),
      method: method,
      form: String(row[columnIndex.form]).trim(),
      // 容量は容量照合で使う。ここで渡し忘れると照合が素通りする。
      capacity: capacity > 0 ? capacity : null,
      servingSize: servingSize > 0 ? servingSize : null,
      proteinPerServing: proteinPerServing > 0 ? proteinPerServing : null,
      keyword: String(row[columnIndex.keyword]).trim(),
      status: status,
      totalProtein: totalProtein,
      inferred: false
    });
  }

  // 重複は静かに間違えるより止まったほうがよいので、処理を中断する。
  if (duplicateIds.length > 0) {
    throw new Error(
      '商品IDが重複しています。1行につき1つのIDにしてください。\n' +
      duplicateIds.join('\n') + '\n' +
      '容量違い・味違いは別のIDにします（例: dns-whey100-choco-315 / dns-whey100-choco-630）。'
    );
  }

  // 容量に1食分を入れてしまっているパウダーを警告する。
  // 止めはしないが、そのままだと1袋のタンパク質が桁違いに小さくなる。
  const suspicious = [];

  products.forEach(function (product) {
    if (product.form !== 'パウダー') return;
    if (!product.capacity || !product.servingSize) return;

    if (product.capacity <= product.servingSize) {
      suspicious.push(
        product.productId +
        '（容量' + product.capacity + 'g / 1食' + product.servingSize + 'g）'
      );
    }
  });

  if (suspicious.length > 0) {
    Logger.log(
      '警告: 容量が1食分以下のパウダーがあります。\n' +
      '「容量g」には1袋の内容量を入れてください（1食分ではありません）。\n' +
      suspicious.join('\n')
    );
  }

  return products;
}

/**
 * API側に渡す除外キーワードを組み立てる。
 * 長さ上限に収まるところまでを採用する。
 */
function buildNgKeyword_(form) {
  if (!CONFIG.USE_API_NG_KEYWORD || !NG_KEYWORD_SUPPORTED) {
    return '';
  }

  let words = NG_KEYWORD_COMMON.slice();

  if (form === 'パウダー') {
    words = words.concat(NG_KEYWORD_POWDER);
  }

  const picked = [];
  let budget = CONFIG.NG_KEYWORD_MAX_HALF_WIDTH;

  for (let i = 0; i < words.length; i++) {
    const cost = halfWidthLength_(words[i]) + 1;

    if (cost > budget) {
      break;
    }

    picked.push(words[i]);
    budget -= cost;
  }

  return picked.join(' ');
}

/**
 * 半角換算の文字数。全角は2文字として数える。
 */
function halfWidthLength_(text) {
  const s = String(text);
  let length = 0;

  for (let i = 0; i < s.length; i++) {
    length += s.charCodeAt(i) < 128 ? 1 : 2;
  }

  return length;
}

/**
 * 楽天市場の商品検索APIを叩く。
 * 指定されたページ数ぶんを順に取り、同じ商品は1件にまとめて返す。
 *
 * 価格の安い順に取っている都合で、1ページ目が小分けやサンプルで
 * 埋まってしまうことがある。母数を増やすことで本命が入る確率を上げる。
 *
 * options:
 *   pages     … 取得するページ数（既定1）
 *   ngKeyword … API側の除外キーワード（既定なし）
 */
function searchRakuten_(credentials, keyword, hits, options) {
  const opt = options || {};
  const pages = Math.max(1, Math.min(10, opt.pages || 1));
  const ngKeyword = opt.ngKeyword || '';

  const collected = [];
  const seen = {};

  for (let page = 1; page <= pages; page++) {
    const items = fetchRakutenPage_(credentials, keyword, hits, page, ngKeyword);

    if (items.length === 0) {
      break;
    }

    items.forEach(function (item) {
      const key = item.itemUrl || item.cleanName;

      if (seen[key]) {
        return;
      }

      seen[key] = true;
      collected.push(item);
    });

    // 返ってきた件数が要求より少なければ、次のページは無い
    if (items.length < hits) {
      break;
    }

    if (page < pages) {
      Utilities.sleep(CONFIG.REQUEST_INTERVAL_MS);
    }
  }

  return collected;
}

/**
 * 1ページぶんを取る。
 * NGKeyword が拒否された場合は、付けずに1回だけやり直す。
 * 2026年版エンドポイントで NGKeyword が使えるか公式資料で確認できていないため。
 */
function fetchRakutenPage_(credentials, keyword, hits, page, ngKeyword) {
  try {
    return requestRakuten_(credentials, keyword, hits, page, ngKeyword);
  } catch (e) {
    if (ngKeyword && e.message.indexOf('400') !== -1) {
      Logger.log(
        '警告: NGKeyword がこのエンドポイントで使えないようです。' +
        '以降は付けずに実行します（除外はGAS側で行われるので判定精度は変わりません）。'
      );
      NG_KEYWORD_SUPPORTED = false;
      return requestRakuten_(credentials, keyword, hits, page, '');
    }

    throw e;
  }
}

/**
 * 実際のHTTPリクエスト。
 * applicationId と accessKey の両方をクエリパラメータで送り、
 * Origin / Referer ヘッダに登録済みドメインを乗せる。
 *
 * スクリプトプロパティに RAKUTEN_AFFILIATE_ID があれば affiliateId として送る。
 * これを付けると、返ってくる itemUrl が最初からアフィリエイトリンクになるので、
 * 商品ごとに手でリンクを作る必要がない。
 * 未設定でも動く（そのときは通常のリンクが返る）。
 */
function requestRakuten_(credentials, keyword, hits, page, ngKeyword) {
  const url = CONFIG.API_ENDPOINT +
    '?applicationId=' + encodeURIComponent(credentials.appId) +
    '&accessKey=' + encodeURIComponent(credentials.accessKey) +
    (credentials.affiliateId ? '&affiliateId=' + encodeURIComponent(credentials.affiliateId) : '') +
    '&keyword=' + encodeURIComponent(keyword) +
    (ngKeyword ? '&NGKeyword=' + encodeURIComponent(ngKeyword) : '') +
    '&hits=' + hits +
    '&page=' + (page || 1) +
    '&sort=' + encodeURIComponent('+itemPrice') +
    '&format=json' +
    '&formatVersion=2';

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Origin': CONFIG.ORIGIN,
      'Referer': CONFIG.ORIGIN + '/'
    },
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code === 400) {
    throw new Error(
      '楽天APIがリクエストを拒否しました（400）: ' + body.slice(0, 200) +
      ' / API Configuration not found と出る場合はエンドポイントのバージョンが古い可能性があります。'
    );
  }

  if (code === 403) {
    throw new Error(
      '楽天APIがアクセスを拒否しました（403）: ' + body.slice(0, 200) +
      ' / 楽天管理画面の「許可されたウェブサイト」に ' + CONFIG.ORIGIN.replace('https://', '') +
      ' が登録されているか確認してください。'
    );
  }

  if (code === 404) {
    // ページを進めた結果、対象が無くなった場合もここに来る
    if (page && page > 1) {
      return [];
    }

    throw new Error(
      '楽天APIのエンドポイントが見つかりません（404）: ' + CONFIG.API_ENDPOINT +
      ' / パスかバージョン日付が変更された可能性があります。'
    );
  }

  if (code === 429) {
    throw new Error('楽天APIのリクエスト制限に達しました（429）。時間をおいて再実行してください。');
  }

  if (code !== 200) {
    throw new Error('楽天APIがエラーを返しました（HTTP ' + code + '）: ' + body.slice(0, 200));
  }

  const data = JSON.parse(body);

  if (!data.Items || data.Items.length === 0) {
    return [];
  }

  return data.Items.map(function (item) {
    return {
      itemName: item.itemName,
      cleanName: cleanItemName_(item.itemName),
      itemPrice: Number(item.itemPrice),
      postage: item.postageFlag === 0 ? '込' : '別',
      shopName: item.shopName,
      shopCode: item.shopCode || '',
      itemUrl: item.itemUrl,
      imageUrl: bestImage_(item)
    };
  });
}

/**
 * 一番大きい商品画像のURLを選ぶ。
 * 楽天は末尾に ?_ex=128x128 のようなサイズ指定を付けて返すので、
 * それを外して原寸に近いものを取る。
 *
 * formatVersion=2 では *ImageUrls が文字列の配列、
 * v1 では {imageUrl:...} の配列なので、どちらでも読めるようにしている。
 */
function bestImage_(item) {
  const lists = [item.mediumImageUrls, item.smallImageUrls];

  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];

    if (!list || !list.length) {
      continue;
    }

    const first = list[0];
    const url = (typeof first === 'string') ? first : (first && first.imageUrl);

    if (url) {
      return String(url).replace(/\?_ex=\d+x\d+$/, '');
    }
  }

  return '';
}

/**
 * 表示用の名前を組み立てる。
 */
function buildDisplayName_(product) {
  return [product.brand, product.series, product.flavor]
    .filter(function (part) { return part; })
    .join(' ');
}

/**
 * シートを作り直して書き込む（検索テスト用）。
 */
function writeSheet_(sheetName, header, rows) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (sheet) {
    sheet.clear();
  } else {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
}

/**
 * シートの末尾に追記する（価格ログ用）。既存の行は消さない。
 */
function appendToSheet_(sheetName, header, rows) {
  if (rows.length === 0) {
    return;
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, header.length).setValues(rows);
}