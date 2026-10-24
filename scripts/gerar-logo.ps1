# Gera as versões do emblema oficial usadas pelo app a partir do arquivo original (que NÃO é alterado).
# O original é localizado por "Emblema*.png" em ../imagem referencia (evita acentos no código: o PowerShell 5.1 pode ler a codificação errada).
#
# Preparo (sem redesenhar nada, sem ampliar): limpa o ruído de alfa (1-3), normaliza o corpo opaco (alfa >= 250 vira 255),
# recentraliza com respiro igual nos quatro lados e reduz com interpolação de alta qualidade (em espaço pré-multiplicado).
# Saídas:
#   src/renderer/assets/brand/jk-emblem.png       emblema, 768 x 768, transparente
#   src/renderer/assets/brand/jk-emblem-128.png   emblema, 128 x 128, transparente (menu lateral, barra superior)
#   build/icon.ico                                ícone do aplicativo (16 a 256 px), transparente
#   build/icon.png                                ícone 512 x 512 (janela em desenvolvimento)
# Uso: powershell -ExecutionPolicy Bypass -File scripts/gerar-logo.ps1
param([string]$Imagem = (Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '../imagem referencia') -Filter 'Emblema*.png' -File | Select-Object -First 1 -ExpandProperty FullName))

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class EmblemaGerador {
  static byte[] Ler(Bitmap b, out int stride) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    stride = d.Stride; var buf = new byte[d.Stride * b.Height]; Marshal.Copy(d.Scan0, buf, 0, buf.Length); b.UnlockBits(d); return buf;
  }
  // Abre o arquivo em memória como ARGB (sem manter o arquivo aberto).
  public static Bitmap Carregar(string caminho) {
    using (var o = new Bitmap(caminho)) {
      var b = new Bitmap(o.Width, o.Height, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(b)) { g.CompositingMode = CompositingMode.SourceCopy; g.DrawImage(o, 0, 0, o.Width, o.Height); }
      return b;
    }
  }
  // Limpeza de alfa: ruído (< 4) some; corpo quase opaco (>= 250) vira opaco total. A cor dos pixels não muda.
  public static Bitmap Limpar(Bitmap src, out long ruido, out long normalizados) {
    ruido = 0; normalizados = 0;
    var dst = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
    var area = new Rectangle(0, 0, src.Width, src.Height);
    int stride; var buf = Ler(src, out stride);
    for (int y = 0; y < src.Height; y++) for (int x = 0; x < src.Width; x++) {
      int i = y * stride + x * 4, a = buf[i + 3];
      if (a > 0 && a < 4) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; ruido++; }
      else if (a >= 250 && a < 255) { buf[i + 3] = 255; normalizados++; }
    }
    var dd = dst.LockBits(area, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(buf, 0, dd.Scan0, buf.Length); dst.UnlockBits(dd);
    return dst;
  }
  public static int[] Caixa(Bitmap b, int limiar) {
    int stride; var p = Ler(b, out stride);
    int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
    for (int y = 0; y < b.Height; y++) for (int x = 0; x < b.Width; x++) if (p[y * stride + x * 4 + 3] >= limiar) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return new int[] { x0, y0, x1, y1 };
  }
  // Recorte quadrado centrado no conteúdo (a parte que sai da imagem fica transparente).
  public static Bitmap Quadrado(Bitmap src, double cx, double cy, int lado) {
    var dst = new Bitmap(lado, lado, PixelFormat.Format32bppArgb);
    int ox = (int)Math.Round(cx - lado / 2.0), oy = (int)Math.Round(cy - lado / 2.0);
    int sx0 = Math.Max(ox, 0), sy0 = Math.Max(oy, 0), sx1 = Math.Min(ox + lado, src.Width), sy1 = Math.Min(oy + lado, src.Height);
    using (var g = Graphics.FromImage(dst)) {
      g.CompositingMode = CompositingMode.SourceCopy;
      if (sx1 > sx0 && sy1 > sy0) g.DrawImage(src, new Rectangle(sx0 - ox, sy0 - oy, sx1 - sx0, sy1 - sy0), new Rectangle(sx0, sy0, sx1 - sx0, sy1 - sy0), GraphicsUnit.Pixel);
    }
    return dst;
  }
  // Redução em espaço pré-multiplicado (evita franjas escuras nas bordas semitransparentes).
  public static Bitmap Escalar(Bitmap src, int w, int h) {
    var pre = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppPArgb);
    using (var g = Graphics.FromImage(pre)) { g.CompositingMode = CompositingMode.SourceCopy; g.DrawImage(src, 0, 0, src.Width, src.Height); }
    var dst = new Bitmap(w, h, PixelFormat.Format32bppPArgb);
    using (var g = Graphics.FromImage(dst)) {
      g.CompositingMode = CompositingMode.SourceCopy;
      g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.SmoothingMode = SmoothingMode.HighQuality;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.CompositingQuality = CompositingQuality.HighQuality;
      using (var at = new ImageAttributes()) { at.SetWrapMode(WrapMode.TileFlipXY); g.DrawImage(pre, new Rectangle(0, 0, w, h), 0, 0, pre.Width, pre.Height, GraphicsUnit.Pixel, at); }
    }
    var fim = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(fim)) { g.CompositingMode = CompositingMode.SourceCopy; g.DrawImage(dst, 0, 0, w, h); }
    return fim;
  }
  public static void Png(Bitmap b, string caminho) { Directory.CreateDirectory(Path.GetDirectoryName(caminho)); b.Save(caminho, ImageFormat.Png); }
  // Imagem de ícone no formato bitmap (DIB 32 bits com alfa + máscara), aceito por todas as ferramentas do Windows.
  static byte[] Dib(Bitmap im) {
    int w = im.Width, h = im.Height; int stride; var px = Ler(im, out stride);
    int maskStride = ((w + 31) / 32) * 4;
    using (var ms = new MemoryStream()) using (var bw = new BinaryWriter(ms)) {
      bw.Write(40); bw.Write(w); bw.Write(h * 2); bw.Write((short)1); bw.Write((short)32); bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0);
      for (int y = h - 1; y >= 0; y--) bw.Write(px, y * stride, w * 4);
      bw.Write(new byte[maskStride * h]);
      return ms.ToArray();
    }
  }
  // .ico padrão: bitmap nos tamanhos pequenos e PNG somente em 256 px (como o Windows espera).
  public static void Ico(string caminho, List<Bitmap> imagens) {
    Directory.CreateDirectory(Path.GetDirectoryName(caminho));
    var dados = new List<byte[]>();
    foreach (var im in imagens) {
      if (im.Width >= 256) using (var ms = new MemoryStream()) { im.Save(ms, ImageFormat.Png); dados.Add(ms.ToArray()); } else dados.Add(Dib(im));
    }
    using (var fs = new FileStream(caminho, FileMode.Create)) using (var w = new BinaryWriter(fs)) {
      w.Write((short)0); w.Write((short)1); w.Write((short)imagens.Count);
      int offset = 6 + 16 * imagens.Count;
      for (int i = 0; i < imagens.Count; i++) {
        w.Write((byte)(imagens[i].Width >= 256 ? 0 : imagens[i].Width)); w.Write((byte)(imagens[i].Height >= 256 ? 0 : imagens[i].Height));
        w.Write((byte)0); w.Write((byte)0); w.Write((short)1); w.Write((short)32); w.Write(dados[i].Length); w.Write(offset); offset += dados[i].Length;
      }
      foreach (var d in dados) w.Write(d);
    }
  }
}
'@

if (-not $Imagem) { throw 'Emblema*.png não encontrado em ../imagem referencia' }
$raiz = Resolve-Path (Join-Path $PSScriptRoot '..')
$brand = Join-Path $raiz 'src/renderer/assets/brand'
$build = Join-Path $raiz 'build'

$orig = [EmblemaGerador]::Carregar($Imagem)
"origem: $($orig.Width) x $($orig.Height) (somente leitura): $Imagem"
$ruido = 0L; $norm = 0L
$limpa = [EmblemaGerador]::Limpar($orig, [ref]$ruido, [ref]$norm)
"limpeza de alfa: $ruido pixels de ruido (alfa 1-3) removidos; $norm pixels quase opacos (250-254) normalizados para 255"
$c = [EmblemaGerador]::Caixa($limpa, 16)
$cx = ($c[0] + $c[2]) / 2.0; $cy = ($c[1] + $c[3]) / 2.0; $alt = $c[3] - $c[1] + 1
"conteudo visivel: x $($c[0])-$($c[2]), y $($c[1])-$($c[3]) ($($c[2]-$c[0]+1) x $alt); centro ($cx, $cy)"

# Respiro igual nos quatro lados: ~6,8% para a interface e ~3,6% para o ícone (legibilidade em tamanhos pequenos).
$ladoUi = [int][math]::Round($alt / 0.88)
$ladoIcone = [int][math]::Round($alt / 0.93)
$ui = [EmblemaGerador]::Quadrado($limpa, $cx, $cy, $ladoUi)
$icone = [EmblemaGerador]::Quadrado($limpa, $cx, $cy, $ladoIcone)
"quadro da interface: $ladoUi px | quadro do icone: $ladoIcone px"

[EmblemaGerador]::Png([EmblemaGerador]::Escalar($ui, 768, 768), (Join-Path $brand 'jk-emblem.png'))
[EmblemaGerador]::Png([EmblemaGerador]::Escalar($ui, 128, 128), (Join-Path $brand 'jk-emblem-128.png'))
$lista = New-Object 'System.Collections.Generic.List[System.Drawing.Bitmap]'
foreach ($t in 256, 128, 64, 48, 32, 24, 16) { $lista.Add([EmblemaGerador]::Escalar($icone, $t, $t)) }
[EmblemaGerador]::Ico((Join-Path $build 'icon.ico'), $lista)
[EmblemaGerador]::Png([EmblemaGerador]::Escalar($icone, 512, 512), (Join-Path $build 'icon.png'))

foreach ($arq in @('src/renderer/assets/brand/jk-emblem.png', 'src/renderer/assets/brand/jk-emblem-128.png', 'build/icon.ico', 'build/icon.png')) {
  $i = Get-Item (Join-Path $raiz $arq); "{0,-44} {1,9:N0} bytes" -f $arq, $i.Length
}
