// ClawsGO 云主机 · 获取 + 维持（电脑端）
//
// 协议来自对 ClawsGO Science 1.1.3 的静态逆向：
//   API 基址 : https://api.clawsgo.cn
//   RPC 形态 : POST /api/<name>   body = {"data":{...}}
//              headers: Authorization: Bearer <会话 token>
//                       x-team-id: <teamId>（可选）
//              响应   : {"data":…,"error":null}  业务错误放 error 字段，HTTP 仍可能 200
//   已确认 RPC: getTeams / getDevices / getHosts / createHost / deleteHost
//
// 安全约定（重要）：
//   * 默认**只读**：只调 getTeams / getHosts。
//   * createHost / deleteHost 只在显式给出 --ensure / --recreate 时才会发。
//   * 任何未知接口一律不试探。

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// API 基址在 Api 类里（顶级语句的局部变量对静态类不可见）

var opt = Parser.Parse(args);
if (opt.ShowHelp) { Console.WriteLine(Parser.Help); return 0; }

var token = opt.Token;
if (string.IsNullOrEmpty(token) && opt.FromLevelDb) token = LevelDbToken.TryRead();
if (string.IsNullOrEmpty(token))
{
    Console.Error.WriteLine("没有 token：用 --token 指定，或 --from-leveldb 从应用登录态读取。");
    return 2;
}

using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

// ── 1. 团队（只读）────────────────────────────────────────
var teams = await Api.Post(http, token, null, "getTeams", new { });
if (!teams.Ok) { Console.Error.WriteLine($"getTeams 失败：{teams.Error}"); return 3; }

string? teamId = null;
using (var doc = JsonDocument.Parse(teams.Raw))
{
    if (doc.RootElement.TryGetProperty("data", out var data) &&
        data.ValueKind == JsonValueKind.Object &&
        data.TryGetProperty("teams", out var arr) && arr.ValueKind == JsonValueKind.Array)
    {
        foreach (var t in arr.EnumerateArray())
        {
            teamId = t.GetProperty("id").GetString();
            var name = t.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : "";
            Console.WriteLine($"团队: {teamId}  名称: {(string.IsNullOrEmpty(name) ? "(空)" : name)}");
            break;
        }
    }
}
if (teamId is null) { Console.Error.WriteLine("没有团队，无法继续。"); return 3; }

// ── 2. 主机（只读）────────────────────────────────────────
async Task<HostInfo?> FindCloudHost()
{
    var res = await Api.Post(http, token, teamId, "getHosts", new { teamId });
    if (!res.Ok) { Console.Error.WriteLine($"getHosts 失败：{res.Error}"); return null; }
    using var doc = JsonDocument.Parse(res.Raw);
    if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object) return null;
    if (!data.TryGetProperty("hosts", out var hosts) || hosts.ValueKind != JsonValueKind.Array) return null;
    foreach (var h in hosts.EnumerateArray())
    {
        var kind = h.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() : null;
        if (kind != "cloud") continue;
        return new HostInfo(
            h.GetProperty("id").GetString()!,
            h.TryGetProperty("online", out var on) && on.ValueKind == JsonValueKind.True,
            h.TryGetProperty("instanceId", out var ins) && ins.ValueKind == JsonValueKind.String ? ins.GetString() : null,
            h.TryGetProperty("title", out var ti) && ti.ValueKind == JsonValueKind.String ? ti.GetString() : null);
    }
    return null;
}

var host = await FindCloudHost();

if (host is null && opt.Ensure)
{
    Console.WriteLine("没有云主机，按 --ensure 请求创建（这是写操作）…");
    var created = await Api.Post(http, token, teamId, "createHost", new { kind = "cloud", teamId });
    Console.WriteLine(created.Ok ? $"创建返回：{Trim(created.Raw, 300)}" : $"创建失败：{created.Error}");
    host = await FindCloudHost();
}

void Report(HostInfo? h)
{
    var stamp = DateTime.Now.ToString("HH:mm:ss");
    if (h is null) Console.WriteLine($"[{stamp}] 云主机: 无");
    else Console.WriteLine($"[{stamp}] 云主机: id={h.Id} online={(h.Online ? "✔" : "✘")} instance={(h.InstanceId ?? "-")} title={(string.IsNullOrEmpty(h.Title) ? "(空)" : h.Title)}");
}

Report(host);
if (opt.Once || opt.Watch <= 0) return 0;

// ── 3. 维持（只读观察；--recreate 才写）───────────────────
Console.WriteLine($"开始监视，每 {opt.Watch}s 一次；Ctrl+C 退出。");
var offlineStreak = 0;
while (true)
{
    await Task.Delay(TimeSpan.FromSeconds(opt.Watch));
    var cur = await FindCloudHost();
    Report(cur);

    if (cur is null)
    {
        offlineStreak++;
    }
    else if (!cur.Online)
    {
        offlineStreak++;
        if (offlineStreak >= 3 && opt.Recreate && host is not null)
        {
            Console.WriteLine($"连续 {offlineStreak} 次离线，按 --recreate 删除重建（写操作）…");
            var del = await Api.Post(http, token, teamId, "deleteHost", new { hostId = host.Id, teamId });
            Console.WriteLine(del.Ok ? "已删除" : $"删除失败：{del.Error}");
            if (del.Ok)
            {
                var mk = await Api.Post(http, token, teamId, "createHost", new { kind = "cloud", teamId });
                Console.WriteLine(mk.Ok ? "已请求重建" : $"重建失败：{mk.Error}");
            }
            offlineStreak = 0;
            host = await FindCloudHost();
        }
    }
    else { offlineStreak = 0; host = cur; }
}

static string Trim(string s, int n) => s.Length <= n ? s : s[..n] + "…";

// ── 数据结构与辅助 ────────────────────────────────────────
record HostInfo(string Id, bool Online, string? InstanceId, string? Title);

sealed class Options
{
    public string? Token; public bool FromLevelDb; public bool Ensure; public bool Once;
    public bool Recreate; public int Watch; public bool ShowHelp;
}

static class Parser
{
    public const string Help = """
        hostd —— ClawsGO 云主机获取/维持（默认只读）
          --from-leveldb        从应用登录态读会话 token
          --token <token>       直接给 token
          --once                只查一次（默认行为）
          --watch <秒>          轮询间隔
          --ensure              没有云主机就创建一台（写操作）
          --recreate            连续 3 次离线则删除重建（写操作，谨慎）
        """;

    public static Options Parse(string[] a)
    {
        var o = new Options();
        for (int i = 0; i < a.Length; i++)
        {
            switch (a[i])
            {
                case "--from-leveldb": o.FromLevelDb = true; break;
                case "--token": o.Token = a[++i]; break;
                case "--ensure": o.Ensure = true; break;
                case "--once": o.Once = true; break;
                case "--recreate": o.Recreate = true; break;
                case "--watch": o.Watch = int.Parse(a[++i]); break;
                case "-h" or "--help": o.ShowHelp = true; break;
            }
        }
        return o;
    }
}

static class LevelDbToken
{
    // Chromium 的 localStorage 落在 %APPDATA%\ClawsGO\cn\Local Storage\leveldb\*.log
    // 值是**不透明会话令牌**（不是 JWT），形如 "xxxx.yyyy="
    public static string? TryRead()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "ClawsGO", "cn", "Local Storage", "leveldb");
        if (!Directory.Exists(root)) return null;
        var rx = new Regex(@"clawsgo_token.{0,8}?([A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-+/=]{20,})",
            RegexOptions.Singleline);
        foreach (var f in Directory.EnumerateFiles(root).OrderByDescending(File.GetLastWriteTimeUtc))
        {
            try
            {
                var text = Encoding.ASCII.GetString(File.ReadAllBytes(f));
                var m = rx.Match(text);
                if (m.Success) return m.Groups[1].Value;
            }
            catch { }
        }
        return null;
    }
}

static class Api
{
    const string ApiBase = "https://api.clawsgo.cn";
    public static async Task<(bool Ok, string Raw, string? Error)> Post(
        HttpClient http, string token, string? teamId, string name, object payload)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, $"{ApiBase}/api/{name}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrEmpty(teamId)) req.Headers.Add("x-team-id", teamId);
        var json = JsonSerializer.Serialize(new { data = payload });
        req.Content = new StringContent(json, Encoding.UTF8, "application/json");

        try
        {
            using var res = await http.SendAsync(req);
            var body = await res.Content.ReadAsStringAsync();
            // 业务错误放在 error 字段里，HTTP 仍可能是 200
            if (body.Contains("\"error\":{") || body.Contains("\"error\": {"))
            {
                try
                {
                    using var d = JsonDocument.Parse(body);
                    if (d.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.Object)
                    {
                        var code = e.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : "?";
                        var msg = e.TryGetProperty("message", out var m2) && m2.ValueKind == JsonValueKind.String ? m2.GetString() : "";
                        return (false, body, $"{code} {msg}");
                    }
                }
                catch { }
            }
            return (res.IsSuccessStatusCode, body, res.IsSuccessStatusCode ? null : $"HTTP {(int)res.StatusCode}");
        }
        catch (Exception ex) { return (false, "", ex.Message); }
    }
}


