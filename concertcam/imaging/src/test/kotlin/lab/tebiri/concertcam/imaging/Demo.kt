package lab.tebiri.concertcam.imaging

import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO

/** 실제 사진으로 알고리즘을 돌려보는 도구. */
fun main(args: Array<String>) {
    when (args.getOrNull(0)) {
        "descreen" -> {
            val img = ImageIO.read(File(args[1]))
            val w = img.width
            val h = img.height
            val px = img.getRGB(0, 0, w, h, null, 0, w)
            val t = System.currentTimeMillis()
            Descreen.process(px, w, h, args.getOrNull(3)?.toInt() ?: 2)
            println("descreen ${w}x$h: ${System.currentTimeMillis() - t} ms")
            val out = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
            out.setRGB(0, 0, w, h, px, 0, w)
            ImageIO.write(out, "png", File(args[2]))
        }
        else -> println("usage: descreen <in> <out.png> [strength 1..3]")
    }
}
