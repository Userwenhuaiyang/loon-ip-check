// 节点 IP 检测 for Loon 3.5.1+ (generic 脚本)
// 长按节点 -> IP 检测，请求走长按的那个节点
// 主数据源：IPPure https://my.ippure.com/v1/info（免费公开 API，无需 token）
//   返回调用方出口 IP + fraudScore（IPPure系数，0-100，越高风险越大）
//   + isBroadcast（IP来源：广播IP / 原生IP）
//   + isResidential（IP属性：住宅IP / 机房IP）
//   健康分 = 100 - IPPure系数，分数越高越干净
// 备用：如果 IPPure 没给系数（比如 IPv6），用 ipinfo + ip-api 的老算法兜底

function getNodeName() {
  try {
    if (typeof $environment !== 'undefined' && $environment && $environment.params) {
      var p = $environment.params;
      if (typeof p.node === 'string' && p.node) return p.node;
      if (p.nodeInfo) {
        if (typeof p.nodeInfo === 'string') return p.nodeInfo;
        return p.nodeInfo.name || p.nodeInfo.nodeName || p.nodeInfo.policy || null;
      }
    }
  } catch (e) {}
  return null;
}

function get(url, node) {
  return new Promise(function (resolve) {
    var opts = { url: url, timeout: 8000, headers: { 'Accept': 'application/json', 'User-Agent': 'Loon' } };
    if (node) opts.node = node;
    $httpClient.get(opts, function (error, response, data) {
      if (error || !data || (response && response.status && response.status !== 200)) { resolve(null); return; }
      try {
        var s = (typeof data === 'string') ? data : String(data);
        resolve(JSON.parse(s));
      } catch (e) { resolve(null); }
    });
  });
}

var HOSTING_ORGS = [
  'hytron', 'akile', 'squirrel', 'reliablesite', '1gservers', 'hostus',
  'choopa', 'vultr', 'digitalocean', 'linode', 'akamai', 'ovh', 'hetzner',
  'contabo', 'amazon', 'google cloud', 'microsoft', 'azure', 'alibaba cloud',
  'tencent cloud', 'novamatrix', 'm247', 'datacamp', 'leaseweb', 'server',
  'hosting', 'datacenter', 'data center', 'cloud'
];

function riskLabel(fraud) {
  if (fraud <= 15) return '极低风险';
  if (fraud <= 25) return '低风险';
  if (fraud <= 40) return '轻度风险';
  if (fraud <= 50) return '中轻度风险';
  if (fraud <= 70) return '中度风险';
  if (fraud <= 90) return '高风险';
  return '极高风险';
}

function gradeFor(score) {
  if (score >= 90) return { grade: '✅ 非常干净', advice: '放心用，注册重要账号也可以' };
  if (score >= 70) return { grade: '✅ 比较干净', advice: '可以用' };
  if (score >= 50) return { grade: '⚠️ 一般', advice: '重要账号慎用' };
  if (score >= 30) return { grade: '⚠️ 比较脏', advice: '重要账号别用' };
  return { grade: '❌ 很脏', advice: '别用这个节点' };
}

(async function () {
  var node = getNodeName();

  // 1) IPPure 主接口：走节点，返回的就是该节点的出口 IP
  var pure = await get('https://my.ippure.com/v1/info', node);

  var ip = pure && pure.ip ? pure.ip : null;
  var fraud = (pure && typeof pure.fraudScore === 'number') ? pure.fraudScore : null;
  var score = null, source = '';
  var country = '', region = '', city = '', org = '', timezone = '', asn = '';
  var ipSource = '', ipAttr = '';

  if (pure) {
    country = pure.countryCode || pure.country || '';
    region = pure.region || '';
    city = pure.city || '';
    org = pure.asOrganization || '';
    timezone = pure.timezone || '';
    asn = pure.asn ? ('AS' + pure.asn) : '';
    // IP来源：isBroadcast true = 广播IP，false = 原生IP
    if (typeof pure.isBroadcast === 'boolean') ipSource = pure.isBroadcast ? '广播IP' : '原生IP';
    else if (typeof pure.isNative === 'boolean') ipSource = pure.isNative ? '原生IP' : '广播IP';
    // IP属性：优先用接口直接给的机房字段，其次用是否住宅推断
    var dc = pure.isDatacenter || pure.isDataCenter || pure.isDC || pure.datacenter;
    if (dc === true) ipAttr = '机房IP';
    else if (pure.isResidential === true) ipAttr = '住宅IP';
    else if (pure.isResidential === false) ipAttr = '机房IP';
    if (pure.isMobile === true) ipAttr = '移动IP';
  }

  if (fraud !== null) {
    score = 100 - fraud;
    if (score < 0) score = 0;
    source = 'IPPure';
  } else {
    // 2) 备用：IPPure 没给分时，用 ipinfo + ip-api 算
    var info = await get('https://ipinfo.io/json', node);
    var api = await get('https://ip-api.com/json?lang=zh-CN', node);
    if (!api) api = await get('http://ip-api.com/json?lang=zh-CN', node);
    if (!ip) ip = (info && info.ip) || (api && api.query) || null;
    if (!ip) {
      $notification.post('IP 检测失败', node || '', 'IPPure 和备用接口都没返回数据，请确认节点已连通再长按重试一次。');
      $done({ title: 'IP 检测失败', content: '没有拿到出口 IP，请确认节点已连通再试一次。' });
      return;
    }
    if (!country) country = (info && info.country) || (api && api.countryCode) || '';
    if (!region) region = (info && info.region) || (api && api.regionName) || '';
    if (!city) city = (info && info.city) || (api && api.city) || '';
    if (!org) org = (info && info.org) || (api && (api.as || api.org)) || '';
    if (!timezone) timezone = (info && info.timezone) || (api && api.timezone) || '';
    if (!ipAttr) {
      var hosting = api ? !!api.hosting : false;
      var proxy = api ? !!api.proxy : false;
      var mobile = api ? !!api.mobile : false;
      var orgLower = (org + ' ' + (api && api.isp ? api.isp : '')).toLowerCase();
      var hostingOrg = false;
      for (var i = 0; i < HOSTING_ORGS.length; i++) {
        if (orgLower.indexOf(HOSTING_ORGS[i]) !== -1) { hostingOrg = true; break; }
      }
      if (mobile) ipAttr = '移动IP';
      else if (hosting || hostingOrg) ipAttr = '机房IP';
      else ipAttr = '住宅IP';
      score = 100;
      if (hosting) score -= 55;
      else if (hostingOrg) score -= 50;
      if (proxy) score -= 45;
      if (mobile) score -= 10;
      if (!info || !api) score -= 10;
      if (score < 0) score = 0;
    }
    source = '备用算法（IPPure 没给分）';
    if (!ipSource) ipSource = '未知';
  }

  var g = gradeFor(score);
  var loc = [country, region, city].filter(Boolean).join(' ');
  var title = 'IP 健康分 ' + score + '分 ' + g.grade;
  var subtitle = 'IP: ' + ip + (node ? ' (' + node + ')' : '');
  var body = '结论：' + g.advice + '\n'
    + 'IP来源：' + (ipSource || '未知') + '\n'
    + 'IP属性：' + (ipAttr || '未知') + '\n'
    + (fraud !== null ? 'IPPure系数：' + fraud + '% ' + riskLabel(fraud) + '\n' : '')
    + '地区：' + (loc || '未知') + '\n'
    + '运营商：' + (org || '未知') + (asn ? ' ' + asn : '') + '\n'
    + '数据来源：' + source;

  $notification.post(title, subtitle, body);
  $done({ title: title, content: 'IP: ' + ip + '\n' + body });
})().catch(function (e) {
  $notification.post('IP 检测失败', '', '脚本出错了：' + (e && e.message ? e.message : '未知错误'));
  $done({ title: 'IP 检测失败', content: (e && e.message) || '未知错误' });
});
