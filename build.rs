use std::fs;
use std::path::Path;

fn emit_rerun_recursive(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                emit_rerun_recursive(&path);
            } else {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn main() {
    let dist_dir = Path::new("ui/dist");
    if !dist_dir.exists() {
        fs::create_dir_all(dist_dir).expect("failed to create placeholder ui/dist directory");
    }
    emit_rerun_recursive(dist_dir);
    println!("cargo:rerun-if-changed=src/store/migrations");

    let ft8_dir = Path::new("vendor/ft8_lib");
    emit_rerun_recursive(ft8_dir);

    let mut build = cc::Build::new();
    build
        .include(ft8_dir)
        .file("vendor/ft8_lib/digidx_bridge.c")
        .file("vendor/ft8_lib/common/monitor.c")
        .file("vendor/ft8_lib/fft/kiss_fft.c")
        .file("vendor/ft8_lib/fft/kiss_fftr.c")
        .file("vendor/ft8_lib/ft8/constants.c")
        .file("vendor/ft8_lib/ft8/crc.c")
        .file("vendor/ft8_lib/ft8/decode.c")
        .file("vendor/ft8_lib/ft8/encode.c")
        .file("vendor/ft8_lib/ft8/ldpc.c")
        .file("vendor/ft8_lib/ft8/message.c")
        .file("vendor/ft8_lib/ft8/text.c")
        .define("LOG_PRINTF(...)", "((void)0)")
        .opt_level(2)
        .warnings(false);

    if std::env::var("CARGO_CFG_UNIX").is_ok() {
        build
            .define("HAVE_STPCPY", None)
            .define("_POSIX_C_SOURCE", "200809L");
        println!("cargo:rustc-link-lib=m");
    }

    build.compile("digidx_ft8");
}
