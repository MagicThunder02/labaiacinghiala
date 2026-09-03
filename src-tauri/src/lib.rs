mod auth;
mod connector_tls;
mod core;
mod identity;
mod media_bridge;
mod native_upload;
mod pairing;
mod relay_bridge;
mod transport;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            identity::initialize_android_identity_storage(app.handle())
                .map_err(std::io::Error::other)?;

            let state = core::CoreState::initialize(app.handle())
                .map_err(std::io::Error::other)?;
            let relay_bridge = relay_bridge::RelayBridge::start_if_configured(&state)
                .map_err(std::io::Error::other)?;
            // Il client deve potersi avviare anche non ancora associato: endpoint e pin
            // Direct arrivano dal bootstrap di pairing e vengono risolti solo al primo uso.
            let transport = transport::TransportManager::new();
            let media_bridge = media_bridge::MediaBridge::new()
                .map_err(std::io::Error::other)?;

            app.manage(state);
            app.manage(relay_bridge);
            app.manage(native_upload::NativeUploadState::default());
            app.manage(transport);
            app.manage(media_bridge);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core::baia_core_bootstrap,
            core::baia_core_set_server_endpoint,
            core::baia_core_reset_server_endpoint,
            core::baia_core_probe_server,
            auth::baia_core_authorize_request,
            auth::baia_core_authorize_media_url,
            media_bridge::baia_core_media_bridge_url,
            transport::baia_core_api_request,
            identity::baia_core_device_identity,
            native_upload::baia_core_pick_upload_files,
            native_upload::baia_core_release_upload_files,
            native_upload::baia_core_upload_files,
            pairing::baia_core_pairing_status,
            pairing::baia_core_pair_with_invite,
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di Baia");
}
