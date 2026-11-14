pluginManagement {
    repositories {
        google()
        // Maven Central의 Google 공식 미러. 본 저장소가 요청 제한(429)에 걸릴 때를 대비해 먼저 찾는다.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // Maven Central의 Google 공식 미러. 본 저장소가 요청 제한(429)에 걸릴 때를 대비해 먼저 찾는다.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
    }
}
rootProject.name = "concertcam"
include(":imaging", ":app")
