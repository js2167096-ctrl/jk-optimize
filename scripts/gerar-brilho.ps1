# Separa o emblema oficial em duas camadas transparentes para o tema de cores:
#   jk-emblem-base.png  personagem, máscara e detalhes escuros (cor fixa)
#   jk-emblem-glow.png  somente a iluminação azul (olhos, contornos, brilho externo)
# A interface empilha as duas camadas e aplica um filtro de matiz só na camada de brilho, então a
# iluminação acompanha o tema sem tingir o personagem. As cores dos pixels não são redesenhadas:
# cada pixel é dividido entre as camadas por um peso suave (saturação x brilho, só tons azuis).
# Entrada: jk-emblem.png (768) e jk-emblem-128.png, já gerados por gerar-logo.ps1. O original não é alterado.
# Uso: powershell -ExecutionPolicy Bypass -File scripts/gerar-brilho.ps1 [-Previa <pasta>]
param([string]$Previa = '')

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class Brilho {
  static byte[] Ler(Bitmap b, out int stride) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    stride = d.Stride; var buf = new byte[d.Stride * b.Height]; Marshal.Copy(d.Scan0, buf, 0, buf.Length); b.UnlockBits(d); return buf;
  }
  static Bitmap Gravar(byte[] buf, int w, int h) {
    var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(buf, 0, d.Scan0, buf.Length); b.UnlockBits(d); return b;
  }
  static double Suave(double x) { x = Math.Max(0, Math.Min(1, x)); return x * x * (3 - 2 * x); }
  // Peso de "iluminação": tons azuis saturados e claros. Corpo escuro e cinzas ficam com peso 0.
  public static double Peso(int r, int g, int b, double alfa) {
    double mx = Math.Max(r, Math.Max(g, b)) / 255.0, mn = Math.Min(r, Math.Min(g, b)) / 255.0;
    if (mx <= 0) return 0;
    double s = (mx - mn) / mx;
    bool azulado = b >= r + 12 && b >= g - 6;
    if (!azulado) return 0;
    double ws = Suave((s - 0.20) / 0.30);
    // Halo translúcido conta pelo matiz; o restante precisa ser claro o bastante para ser luz e não tom do corpo.
    double wv = alfa < 0.7 ? 1.0 : Suave((mx - 0.28) / 0.30);
    return ws * wv;
  }
  public static void Separar(Bitmap src, out Bitmap baseImg, out Bitmap glowImg, out double erro, out double areaBrilho) {
    int w = src.Width, h = src.Height, st; var p = Ler(src, out st);
    var bb = new byte[st * h]; var gg = new byte[st * h];
    double soma = 0; long n = 0; double area = 0; long visiveis = 0;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int i = y * st + x * 4; int B = p[i], G = p[i + 1], R = p[i + 2], A = p[i + 3];
      if (A == 0) continue;
      double a = A / 255.0, wgt = Peso(R, G, B, a);
      double ga = a * wgt;                                  // alfa da camada de brilho
      double ba = ga >= 0.9999 ? 0 : Math.Max(0, (a - ga) / (1 - ga)); // alfa da base: a composição reproduz o alfa original
      // Base neutra na região luminosa (sem tom azul), mantendo a luminância do pixel.
      double lum = 0.299 * R + 0.587 * G + 0.114 * B; double k = Math.Min(1, wgt * 2);
      int bR = (int)Math.Round(R + (lum - R) * k), bG = (int)Math.Round(G + (lum - G) * k), bB = (int)Math.Round(B + (lum - B) * k);
      gg[i] = (byte)B; gg[i + 1] = (byte)G; gg[i + 2] = (byte)R; gg[i + 3] = (byte)Math.Round(ga * 255);
      bb[i] = (byte)bB; bb[i + 1] = (byte)bG; bb[i + 2] = (byte)bR; bb[i + 3] = (byte)Math.Round(ba * 255);
      // Erro de recomposição (em tema azul) versus o original.
      double oa = ga + ba * (1 - ga);
      double cr = oa > 0 ? (ga * R + ba * (1 - ga) * bR) / oa : 0, cg = oa > 0 ? (ga * G + ba * (1 - ga) * bG) / oa : 0, cb = oa > 0 ? (ga * B + ba * (1 - ga) * bB) / oa : 0;
      soma += (Math.Abs(cr - R) + Math.Abs(cg - G) + Math.Abs(cb - B)) / 3.0 * a + Math.Abs(oa - a) * 255; n++;
      visiveis++; area += wgt;
    }
    erro = n == 0 ? 0 : soma / n; areaBrilho = visiveis == 0 ? 0 : area / visiveis;
    baseImg = Gravar(bb, w, h); glowImg = Gravar(gg, w, h);
  }
  // Prévia: aplica hue-rotate/saturate/brightness (as mesmas matrizes do CSS) à camada de brilho e compõe sobre a base e um fundo escuro.
  public static Bitmap Previa(Bitmap baseImg, Bitmap glowImg, double graus, double sat, double bri, int fundo) {
    int w = baseImg.Width, h = baseImg.Height, s1, s2; var bp = Ler(baseImg, out s1); var gp = Ler(glowImg, out s2);
    double rad = graus * Math.PI / 180, c = Math.Cos(rad), sn = Math.Sin(rad);
    double[] m = {
      0.213 + c * 0.787 - sn * 0.213, 0.715 - c * 0.715 - sn * 0.715, 0.072 - c * 0.072 + sn * 0.928,
      0.213 - c * 0.213 + sn * 0.143, 0.715 + c * 0.285 + sn * 0.140, 0.072 - c * 0.072 - sn * 0.283,
      0.213 - c * 0.213 - sn * 0.787, 0.715 - c * 0.715 + sn * 0.715, 0.072 + c * 0.928 + sn * 0.072 };
    double[] t = {
      0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat,
      0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat,
      0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat };
    var o = new byte[s1 * h];
    double bgR = (fundo >> 16) & 255, bgG = (fundo >> 8) & 255, bgB = fundo & 255;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int i = y * s1 + x * 4;
      double R = bgR, G = bgG, B = bgB;
      double ba = bp[i + 3] / 255.0; R = R * (1 - ba) + bp[i + 2] * ba; G = G * (1 - ba) + bp[i + 1] * ba; B = B * (1 - ba) + bp[i] * ba;
      double ga = gp[i + 3] / 255.0;
      if (ga > 0) {
        double r0 = gp[i + 2], g0 = gp[i + 1], b0 = gp[i];
        double r1 = m[0] * r0 + m[1] * g0 + m[2] * b0, g1 = m[3] * r0 + m[4] * g0 + m[5] * b0, b1 = m[6] * r0 + m[7] * g0 + m[8] * b0;
        double r2 = t[0] * r1 + t[1] * g1 + t[2] * b1, g2 = t[3] * r1 + t[4] * g1 + t[5] * b1, b2 = t[6] * r1 + t[7] * g1 + t[8] * b1;
        r2 = Math.Min(255, Math.Max(0, r2 * bri)); g2 = Math.Min(255, Math.Max(0, g2 * bri)); b2 = Math.Min(255, Math.Max(0, b2 * bri));
        R = R * (1 - ga) + r2 * ga; G = G * (1 - ga) + g2 * ga; B = B * (1 - ga) + b2 * ga;
      }
      o[i] = (byte)B; o[i + 1] = (byte)G; o[i + 2] = (byte)R; o[i + 3] = 255;
    }
    return Gravar(o, w, h);
  }
}
'@

$raiz = Resolve-Path (Join-Path $PSScriptRoot '..')
$brand = Join-Path $raiz 'src/renderer/assets/brand'
foreach ($par in @(@('jk-emblem.png', 'jk-emblem-base.png', 'jk-emblem-glow.png'), @('jk-emblem-128.png', 'jk-emblem-128-base.png', 'jk-emblem-128-glow.png'))) {
  $origem = New-Object System.Drawing.Bitmap (Join-Path $brand $par[0])
  $base = $null; $glow = $null; $erro = 0.0; $area = 0.0
  [Brilho]::Separar($origem, [ref]$base, [ref]$glow, [ref]$erro, [ref]$area)
  $base.Save((Join-Path $brand $par[1]), [System.Drawing.Imaging.ImageFormat]::Png)
  $glow.Save((Join-Path $brand $par[2]), [System.Drawing.Imaging.ImageFormat]::Png)
  "{0}: {1}x{2} | brilho = {3:P1} da área visível | erro de recomposição (tema azul) = {4:N2} níveis" -f $par[0], $origem.Width, $origem.Height, $area, $erro
  if ($Previa -and $par[0] -eq 'jk-emblem.png') {
    New-Item -ItemType Directory -Force $Previa | Out-Null
    # Matiz de destino por tema (o brilho original tem matiz ~215°): blue, red, ruby, violet, emerald, gold, cyan
    $temas = @(@('blue', 0, 1.0, 1.0), @('red', 137, 1.0, 1.0), @('ruby', 122, 1.0, 1.0), @('violet', 51, 1.0, 1.0), @('emerald', -55, 1.0, 1.0), @('gold', -170, 1.0, 1.0), @('cyan', -25, 1.0, 1.0))
    $folha = New-Object System.Drawing.Bitmap (256 * 7), 256
    $g = [System.Drawing.Graphics]::FromImage($folha); $g.InterpolationMode = 'HighQualityBicubic'
    for ($i = 0; $i -lt $temas.Count; $i++) {
      $t = $temas[$i]
      $im = [Brilho]::Previa($base, $glow, $t[1], $t[2], $t[3], 0x070b14)
      $im.Save((Join-Path $Previa ("previa-" + $t[0] + ".png")))
      $g.DrawImage($im, $i * 256, 0, 256, 256)
    }
    $folha.Save((Join-Path $Previa 'previa-folha.png'))
    $base.Save((Join-Path $Previa 'previa-base.png')); $glow.Save((Join-Path $Previa 'previa-glow.png'))
  }
}
foreach ($arq in 'jk-emblem-base.png', 'jk-emblem-glow.png', 'jk-emblem-128-base.png', 'jk-emblem-128-glow.png') {
  $i = Get-Item (Join-Path $brand $arq); "{0,-26} {1,9:N0} bytes" -f $arq, $i.Length
}
