use baia_relay::{protocol::AUTH_TIMEOUT, runtime::RelayRuntime, tls};
use std::{env, net::SocketAddr};
use tokio::{net::TcpListener, time::timeout};
use tokio_rustls::TlsAcceptor;

const DEFAULT_BIND: &str = "0.0.0.0:443";
const BIND_ENV: &str = "BAIA_RELAY_BIND";
const CERT_ENV: &str = "BAIA_RELAY_CERT_PATH";
const KEY_ENV: &str = "BAIA_RELAY_KEY_PATH";

fn main() {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Baia Relay non avviato: runtime Tokio non disponibile: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = runtime.block_on(run()) {
        eprintln!("Baia Relay non avviato: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let bind = env::var(BIND_ENV).unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let bind_address: SocketAddr = bind
        .parse()
        .map_err(|_| format!("{BIND_ENV} deve essere host:porta, ad esempio 0.0.0.0:443."))?;
    let cert_path = env::var(CERT_ENV)
        .map_err(|_| format!("Imposta {CERT_ENV} al fullchain PEM del relay."))?;
    let key_path = env::var(KEY_ENV)
        .map_err(|_| format!("Imposta {KEY_ENV} alla chiave privata PEM del relay."))?;

    let tls = tls::build_server_config(&cert_path, &key_path)?;
    let acceptor = TlsAcceptor::from(tls.config);
    let listener = TcpListener::bind(bind_address)
        .await
        .map_err(|error| format!("Impossibile aprire {bind_address}: {error}"))?;
    let runtime = RelayRuntime::new();

    println!(
        "Baia Relay {} attivo su {} (TLS 1.3, protocollo v{}, cert={})",
        env!("CARGO_PKG_VERSION"),
        bind_address,
        baia_relay::protocol::RELAY_PROTOCOL_VERSION,
        tls.certificate_fingerprint
    );

    loop {
        let (tcp, peer) = listener
            .accept()
            .await
            .map_err(|error| format!("Accept relay fallito: {error}"))?;
        let acceptor = acceptor.clone();
        let runtime = runtime.clone();
        tokio::spawn(async move {
            let tls_stream = match timeout(AUTH_TIMEOUT, acceptor.accept(tcp)).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    eprintln!("TLS relay rifiutato da {peer}: {error}");
                    return;
                }
                Err(_) => {
                    eprintln!("TLS relay scaduto per {peer} prima dell'autenticazione.");
                    return;
                }
            };
            if let Err(error) = runtime.handle_tls_stream(tls_stream).await {
                eprintln!("Sessione relay terminata per {peer}: {error}");
            }
        });
    }
}
