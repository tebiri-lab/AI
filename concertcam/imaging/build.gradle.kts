plugins {
    id("org.jetbrains.kotlin.jvm")
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    maxHeapSize = "2g"
}

// 실제 사진으로 알고리즘을 돌려보는 데모: ./gradlew :imaging:demo --args="descreen in.jpg out.jpg 2"
tasks.register<JavaExec>("demo") {
    classpath = sourceSets["test"].runtimeClasspath
    mainClass.set("lab.tebiri.concertcam.imaging.DemoKt")
    maxHeapSize = "3g"
}
