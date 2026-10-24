# Analisa o emblema oficial (somente leitura): transparência, caixa do conteúdo, respiro, bordas e manchas isoladas.
# O arquivo é localizado por "Emblema*.png" na pasta de referência (evita acentos no código: o PowerShell 5.1 pode ler a codificação errada).
param([string]$Imagem = (Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '../imagem referencia') -Filter 'Emblema*.png' -File | Select-Object -First 1 -ExpandProperty FullName))

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class EmblemaMedida {
  public static byte[] Pixels(Bitmap b, out int stride) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    stride = d.Stride; var buf = new byte[d.Stride * b.Height]; Marshal.Copy(d.Scan0, buf, 0, buf.Length); b.UnlockBits(d); return buf;
  }
  public static int[] Caixa(byte[] p, int stride, int w, int h, int limiarAlfa) {
    int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) if (p[y * stride + x * 4 + 3] >= limiarAlfa) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return new int[] { x0, y0, x1, y1 };
  }
  public static long[] Histograma(byte[] p, int stride, int w, int h) {
    var r = new long[5]; // 0 | 1-31 | 32-127 | 128-254 | 255
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int a = p[y * stride + x * 4 + 3]; r[a == 0 ? 0 : a < 32 ? 1 : a < 128 ? 2 : a < 255 ? 3 : 4]++; }
    return r;
  }
  // Pixels visíveis (alfa >= 24) sem nenhum vizinho visível num raio de 5 px: manchas soltas fora do emblema.
  public static long Isolados(byte[] p, int stride, int w, int h) {
    long n = 0;
    for (int y = 5; y < h - 5; y++) for (int x = 5; x < w - 5; x++) {
      if (p[y * stride + x * 4 + 3] < 24) continue;
      bool vizinho = false;
      for (int dy = -5; dy <= 5 && !vizinho; dy++) for (int dx = -5; dx <= 5; dx++) { if (dx == 0 && dy == 0) continue; if (p[(y + dy) * stride + (x + dx) * 4 + 3] >= 24) { vizinho = true; break; } }
      if (!vizinho) n++;
    }
    return n;
  }
  // Brilho médio (0-255) dos pixels semitransparentes de borda: borda escura demais gera "halo" sobre fundos claros.
  public static double BrilhoBorda(byte[] p, int stride, int w, int h) {
    double soma = 0; long n = 0;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int i = y * stride + x * 4; int a = p[i + 3]; if (a > 0 && a < 128) { soma += (p[i + 2] * 299 + p[i + 1] * 587 + p[i] * 114) / 1000.0; n++; } }
    return n == 0 ? 0 : soma / n;
  }
  public static double AzulBorda(byte[] p, int stride, int w, int h) {
    double soma = 0; long n = 0;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int i = y * stride + x * 4; int a = p[i + 3]; if (a > 0 && a < 128) { soma += p[i] - (p[i + 2] + p[i + 1]) / 2.0; n++; } }
    return n == 0 ? 0 : soma / n;
  }
}
'@

if (-not $Imagem) { throw 'Emblema*.png não encontrado em ../imagem referencia' }
$bmp = New-Object System.Drawing.Bitmap($Imagem)
$w = $bmp.Width; $h = $bmp.Height
"imagem: $w x $h | alfa: $([System.Drawing.Image]::IsAlphaPixelFormat($bmp.PixelFormat))"
$stride = 0
$px = [EmblemaMedida]::Pixels($bmp, [ref]$stride)
foreach ($lim in 1, 16, 128, 250) { $c = [EmblemaMedida]::Caixa($px, $stride, $w, $h, $lim); "caixa do conteudo (alfa >= $lim): x $($c[0])-$($c[2]) (largura $($c[2]-$c[0]+1)), y $($c[1])-$($c[3]) (altura $($c[3]-$c[1]+1))" }
$c = [EmblemaMedida]::Caixa($px, $stride, $w, $h, 16)
"respiro (alfa >= 16): esquerda $($c[0]) | direita $($w-1-$c[2]) | topo $($c[1]) | base $($h-1-$c[3])  (em % do lado: $([math]::Round(100*$c[0]/$w,1))% / $([math]::Round(100*($w-1-$c[2])/$w,1))% / $([math]::Round(100*$c[1]/$h,1))% / $([math]::Round(100*($h-1-$c[3])/$h,1))%)"
$hist = [EmblemaMedida]::Histograma($px, $stride, $w, $h); $tot = $w * $h
"alfa: transparente $([math]::Round(100*$hist[0]/$tot,1))% | quase (1-31) $([math]::Round(100*$hist[1]/$tot,2))% | parcial (32-127) $([math]::Round(100*$hist[2]/$tot,2))% | alto (128-254) $([math]::Round(100*$hist[3]/$tot,2))% | opaco $([math]::Round(100*$hist[4]/$tot,1))%"
"manchas isoladas (alfa >= 24, sem vizinhos num raio de 5 px): $([EmblemaMedida]::Isolados($px, $stride, $w, $h)) pixels"
"brilho medio das bordas semitransparentes: $([math]::Round([EmblemaMedida]::BrilhoBorda($px, $stride, $w, $h),1)) (0=preto, 255=branco) | azul dominante na borda (B-(R+G)/2): $([math]::Round([EmblemaMedida]::AzulBorda($px, $stride, $w, $h),1))"
$bmp.Dispose()

# Brilho tênue cortado pela borda da imagem? (pixels com alfa > 0 em cada uma das 4 bordas do arquivo)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
public static class EmblemaBorda {
  public static int[] Borda(byte[] p, int stride, int w, int h, int lado) {
    int n = 0, max = 0;
    for (int i = 0; i < (lado < 2 ? w : h); i++) {
      int x = lado == 0 || lado == 1 ? i : (lado == 2 ? 0 : w - 1);
      int y = lado == 0 ? 0 : lado == 1 ? h - 1 : i;
      int a = p[y * stride + x * 4 + 3]; if (a > 0) { n++; if (a > max) max = a; }
    }
    return new int[] { n, max };
  }
  public static long Ruido(byte[] p, int stride, int w, int h, int ate) {
    long n = 0;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int a = p[y * stride + x * 4 + 3]; if (a > 0 && a < ate) n++; }
    return n;
  }
  public static int AlfaMaximo(byte[] p, int stride, int w, int h) {
    int m = 0;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int a = p[y * stride + x * 4 + 3]; if (a > m) m = a; }
    return m;
  }
}
'@
$bmp2 = New-Object System.Drawing.Bitmap($Imagem); $st = 0; $p2 = [EmblemaMedida]::Pixels($bmp2, [ref]$st)
foreach ($l in 0..3) { $r = [EmblemaBorda]::Borda($p2, $st, $bmp2.Width, $bmp2.Height, $l); "borda $(@('topo','base','esquerda','direita')[$l]) do arquivo: $($r[0]) pixels com alfa > 0, alfa maximo $($r[1])" }
"pixels com alfa 1-3 (ruido de fundo): $([EmblemaBorda]::Ruido($p2, $st, $bmp2.Width, $bmp2.Height, 4)) | alfa 1-7: $([EmblemaBorda]::Ruido($p2, $st, $bmp2.Width, $bmp2.Height, 8)) | alfa maximo da imagem: $([EmblemaBorda]::AlfaMaximo($p2, $st, $bmp2.Width, $bmp2.Height))"
$bmp2.Dispose()
