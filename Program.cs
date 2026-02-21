using System.Text.Json;
using Microsoft.AspNetCore.StaticFiles;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient();
var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx => {
        var path = ctx.File.PhysicalPath ?? string.Empty;
        if (path.EndsWith(".html") || path.EndsWith(".js") || path.EndsWith(".json") || path.EndsWith(".webmanifest"))
        {
            ctx.Context.Response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
        }
    }
});

// Server-side proxy for Frankfurter API (free, no key, supports historical dates).
// Client calls: GET /api/fx?from=EUR&to=CAD            ? latest rate
//               GET /api/fx?from=EUR&to=CAD&date=2026-02-11 ? rate on that date
app.MapGet("/api/fx", async (string from, string to, string? date, IHttpClientFactory httpFactory) =>
{
    from = from.Trim().ToUpperInvariant();
    to = to.Trim().ToUpperInvariant();

    if (from.Length != 3 || to.Length != 3)
        return Results.BadRequest(new { error = "from and to must be 3-letter currency codes." });

    var datePath = string.IsNullOrWhiteSpace(date) ? "latest" : date.Trim();
    var client = httpFactory.CreateClient();

    try
    {
        var url = $"https://api.frankfurter.app/{datePath}?from={from}&to={to}";
        var json = await client.GetStringAsync(url);
        using var doc = JsonDocument.Parse(json);

        if (!doc.RootElement.TryGetProperty("rates", out var rates) ||
            !rates.TryGetProperty(to, out var rateEl))
        {
            return Results.Json(
                new { error = $"Rate for {from}/{to} not found in Frankfurter response." },
                statusCode: 502);
        }

        var rate = rateEl.GetDecimal();
        var responseDate = doc.RootElement.TryGetProperty("date", out var dateEl)
            ? dateEl.GetString()!
            : datePath;

        return Results.Ok(new { from, to, rate, date = responseDate, source = "frankfurter" });
    }
    catch (HttpRequestException ex)
    {
        return Results.Json(
            new { error = $"Frankfurter API error: {ex.Message}" },
            statusCode: 502);
    }
});

app.MapFallbackToFile("index.html");

app.Run();