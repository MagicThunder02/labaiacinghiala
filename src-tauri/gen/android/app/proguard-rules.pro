# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# libplayer.so usa nomi JNI fissi Java_is_xyz_mpv_MPVLib_* e risolve inoltre
# eventProperty/event/logMessage per nome. Non rinominare questa classe.
-keep class is.xyz.mpv.MPVLib { *; }
-keep class is.xyz.mpv.MPVLib$* { *; }

# Il Core Rust richiama questi metodi sull'Activity tramite JNI/Wry per nome.
-keepclassmembers class it.baia.cinghiala.MainActivity {
    public java.lang.String baiaNativePlayerProbe();
    public boolean baiaNativePlayerOpen(java.lang.String, java.lang.String, java.lang.String, java.lang.String, double, double);
    public void baiaNativePlayerPlay();
    public void baiaNativePlayerPause();
    public void baiaNativePlayerSeek(double);
    public void baiaNativePlayerSetVolume(double);
    public java.lang.String baiaNativePlayerGetState();
    public boolean baiaNativePlayerStop();
}

-keep class it.baia.cinghiala.BaiaNativePlayerBridge { *; }
