package lab.tebiri.concertcam.imaging

import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** 이미지 연산용 공용 스레드 풀. */
object Parallel {
    val threads: Int = Runtime.getRuntime().availableProcessors().coerceIn(1, 8)

    private val pool: ExecutorService = Executors.newFixedThreadPool(threads) { r ->
        Thread(r, "imaging").apply { isDaemon = true }
    }

    /** [0, n) 구간을 스레드 수만큼 연속 구간으로 나눠 body(start, end)를 병렬 실행한다. */
    fun ranges(n: Int, body: (start: Int, end: Int) -> Unit) {
        if (n <= 0) return
        val parts = minOf(threads, n)
        if (parts == 1) {
            body(0, n)
            return
        }
        val tasks = ArrayList<Callable<Unit>>(parts)
        for (p in 0 until parts) {
            val s = (n.toLong() * p / parts).toInt()
            val e = (n.toLong() * (p + 1) / parts).toInt()
            tasks.add(Callable { body(s, e) })
        }
        for (f in pool.invokeAll(tasks)) f.get()
    }

    /** 인덱스 목록의 각 항목을 병렬 실행한다. 항목끼리는 서로 독립이어야 한다. */
    fun each(indices: IntArray, body: (Int) -> Unit) {
        if (indices.isEmpty()) return
        val tasks = indices.map { i -> Callable { body(i) } }
        for (f in pool.invokeAll(tasks)) f.get()
    }
}
