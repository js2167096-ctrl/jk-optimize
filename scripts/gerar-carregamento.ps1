# Gera a base da tela de carregamento a partir da imagem aprovada, SEM alterar o arquivo original.
# A imagem aprovada traz elementos dinâmicos "assados" (barra de progresso, 73%, texto da etapa e a linha de estado).
# Eles são removidos numa cópia derivada (interpolação vertical do fundo ao redor), e a interface desenha por cima
# os valores reais. Todo o resto (personagem, brilho, título, descrição e fundo) permanece pixel a pixel.
# Entrada:  imagem referencia/Tela de Carregamento*.png (localizada por curinga: evita acentos no código)
# Saída:    src/renderer/assets/brand/carregamento-base.png (mesmas dimensões da original)
# Uso: powershell -ExecutionPolicy Bypass -File scripts/gerar-carregamento.ps1 [-Comparar]
param([switch]$Comparar)

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class Carregamento {
  public static Bitmap Limpar(Bitmap src, int[][] regioes) {
    int w = src.Width, h = src.Height;
    var d = src.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int st = d.Stride; var p = new byte[st * h]; Marshal.Copy(d.Scan0, p, 0, p.Length); src.UnlockBits(d);
    foreach (var r in regioes) {
      int x0 = r[0], y0 = r[1], x1 = r[2], y1 = r[3];
      int ya = Math.Max(0, y0 - 4), yb = Math.Min(h - 1, y1 + 4);
      for (int x = x0; x <= x1; x++) {
        // Cor de referência acima e abaixo da região (média de 3 linhas) para cada coluna.
        double[] a = new double[3], b = new double[3];
        for (int k = 0; k < 3; k++) for (int c = 0; c < 3; c++) { a[c] += p[(ya - k) * st + x * 4 + c] / 3.0; b[c] += p[(yb + k > h - 1 ? h - 1 : yb + k) * st + x * 4 + c] / 3.0; }
        for (int y = y0; y <= y1; y++) {
          double t = (y - ya) / (double)(yb - ya);
          for (int c = 0; c < 3; c++) p[y * st + x * 4 + c] = (byte)Math.Round(a[c] + (b[c] - a[c]) * t);
          p[y * st + x * 4 + 3] = 255;
        }
      }
    }
    var o = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var od = o.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(p, 0, od.Scan0, p.Length); o.UnlockBits(od); return o;
  }
  // Diferença média por canal fora das regiões removidas (deve ser 0: o resto da imagem não muda).
  public static double DiferencaFora(Bitmap a, Bitmap b, int[][] regioes) {
    int w = a.Width, h = a.Height;
    var da = a.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var db = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var pa = new byte[da.Stride * h]; var pb = new byte[db.Stride * h];
    Marshal.Copy(da.Scan0, pa, 0, pa.Length); Marshal.Copy(db.Scan0, pb, 0, pb.Length); a.UnlockBits(da); b.UnlockBits(db);
    double soma = 0; long n = 0;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      bool dentro = false; foreach (var r in regioes) if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) { dentro = true; break; }
      if (dentro) continue;
      int i = y * da.Stride + x * 4; soma += Math.Abs(pa[i] - pb[i]) + Math.Abs(pa[i + 1] - pb[i + 1]) + Math.Abs(pa[i + 2] - pb[i + 2]); n += 3;
    }
    return soma / n;
  }
}
'@

$raiz = Resolve-Path (Join-Path $PSScriptRoot '..')
$ref = Get-ChildItem -LiteralPath (Join-Path $raiz 'imagem referencia') -Filter 'Tela de Carregamento*.png' -File | Select-Object -First 1
if (-not $ref) { throw 'Tela de Carregamento*.png não encontrada em imagem referencia' }
"origem: $($ref.FullName) ($([math]::Round($ref.Length/1KB)) KB) - somente leitura"
$ms = New-Object System.IO.MemoryStream (, [System.IO.File]::ReadAllBytes($ref.FullName))
$orig = New-Object System.Drawing.Bitmap $ms
"dimensões: $($orig.Width) x $($orig.Height)"
# Regiões dinâmicas (x0, y0, x1, y1) no sistema de coordenadas da imagem 1536 x 1024:
$regioes = @(
  , @(180, 752, 1296, 842)   # barra de progresso, porcentagem e texto da etapa
  , @(735, 592, 1284, 668)   # linha de estado (ponto verde + texto do executor)
)
$limpa = [Carregamento]::Limpar($orig, $regioes)
$saida = Join-Path $raiz 'src/renderer/assets/brand/carregamento-base.png'
$limpa.Save($saida, [System.Drawing.Imaging.ImageFormat]::Png)
$d = [Carregamento]::DiferencaFora($orig, $limpa, $regioes)
"saída: $saida ($([math]::Round((Get-Item $saida).Length/1KB)) KB) | diferença média fora das regiões removidas: $d (0 = idêntico)"
if ($Comparar) { $limpa.Save((Join-Path $env:TEMP 'carregamento-base-previa.png')) }
