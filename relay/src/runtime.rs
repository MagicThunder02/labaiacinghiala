use crate::{
    client_handshake::ClientHandshake,
    protocol::{
        frame, read_frame_async, write_frame_async, Frame, FrameType, AUTH_TIMEOUT,
        HEARTBEAT_INTERVAL, MAX_CONCURRENT_STREAMS_PER_CLIENT_SESSION, MAX_FRAMES_PER_SECOND_PER_SESSION,
        MAX_PENDING_OPENS, MAX_SESSION_BUFFER_BYTES, MAX_DATA_PAYLOAD_BYTES, SESSION_DEAD_TIMEOUT,
        STREAM_OPEN_TIMEOUT,
    },
    server_auth::{AuthenticatedServer, ServerId},
    server_handshake::ServerHandshake,
    server_registry::{ServerLease, ServerRegistry},
};
use std::{
    collections::HashMap,
    io,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::mpsc,
    time::{interval, sleep, timeout},
};

const FRAME_QUEUE_CAPACITY: usize = MAX_SESSION_BUFFER_BYTES / MAX_DATA_PAYLOAD_BYTES as usize;

type FrameSender = mpsc::Sender<Frame>;

#[derive(Clone)]
struct OnlineServer {
    generation: u64,
    tx: FrameSender,
}

struct Route {
    client_session_id: u64,
    client_stream_id: u64,
    client_tx: FrameSender,
    opened: bool,
    client_fin: bool,
    server_fin: bool,
}

struct FrameRateLimiter {
    window_started: Instant,
    frames: u32,
}

impl FrameRateLimiter {
    fn new() -> Self {
        Self {
            window_started: Instant::now(),
            frames: 0,
        }
    }

    fn observe(&mut self) -> Result<(), String> {
        if self.window_started.elapsed() >= std::time::Duration::from_secs(1) {
            self.window_started = Instant::now();
            self.frames = 0;
        }
        self.frames = self.frames.saturating_add(1);
        if self.frames > MAX_FRAMES_PER_SECOND_PER_SESSION {
            return Err("Rate limit frame relay superato per la sessione autenticata.".to_string());
        }
        Ok(())
    }
}

struct RelayRuntimeInner {
    registry: Mutex<ServerRegistry>,
    online_servers: Mutex<HashMap<ServerId, OnlineServer>>,
    routes: Mutex<HashMap<(ServerId, u64), Route>>,
    next_server_stream_id: AtomicU64,
    next_client_session_id: AtomicU64,
}

#[derive(Clone)]
pub struct RelayRuntime {
    inner: Arc<RelayRuntimeInner>,
}

impl RelayRuntime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RelayRuntimeInner {
                registry: Mutex::new(ServerRegistry::new()),
                online_servers: Mutex::new(HashMap::new()),
                routes: Mutex::new(HashMap::new()),
                next_server_stream_id: AtomicU64::new(1),
                next_client_session_id: AtomicU64::new(1),
            }),
        }
    }

    pub async fn handle_tls_stream<S>(&self, mut stream: S) -> Result<(), String>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let first = timeout(AUTH_TIMEOUT, read_frame_async(&mut stream))
            .await
            .map_err(|_| "Timeout handshake relay.".to_string())?
            .map_err(|error| format!("Primo frame relay non valido: {error}"))?;

        match first.header.frame_type {
            FrameType::ServerHello => self.handle_server(stream, first).await,
            FrameType::ClientHello => self.handle_client(stream, first).await,
            _ => Err("Il primo frame relay deve essere SERVER_HELLO o CLIENT_HELLO.".to_string()),
        }
    }

    async fn handle_server<S>(&self, mut stream: S, first: Frame) -> Result<(), String>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let mut handshake = ServerHandshake::new();
        let challenge = handshake
            .accept_hello(first)
            .map_err(|error| format!("SERVER_HELLO rifiutato: {error}"))?;
        write_frame_async(&mut stream, &challenge)
            .await
            .map_err(|error| format!("Impossibile inviare CHALLENGE server: {error}"))?;

        let auth = timeout(AUTH_TIMEOUT, read_frame_async(&mut stream))
            .await
            .map_err(|_| "Timeout SERVER_AUTH relay.".to_string())?
            .map_err(|error| format!("SERVER_AUTH non leggibile: {error}"))?;
        let (auth_ok, authenticated) = handshake
            .accept_auth(auth)
            .map_err(|error| format!("SERVER_AUTH rifiutato: {error}"))?;
        write_frame_async(&mut stream, &auth_ok)
            .await
            .map_err(|error| format!("Impossibile inviare AUTH_OK server: {error}"))?;

        let (reader, writer) = tokio::io::split(stream);
        let (tx, rx) = mpsc::channel(FRAME_QUEUE_CAPACITY.max(8));
        let lease = self.register_server(authenticated, tx.clone()).await?;

        let writer_task = tokio::spawn(writer_loop(writer, rx));
        let ping_task = tokio::spawn(ping_loop(tx.clone()));
        let result = self.server_read_loop(reader, authenticated.server_id, tx).await;

        ping_task.abort();
        writer_task.abort();
        self.unregister_server(lease).await;
        result
    }

    async fn handle_client<S>(&self, mut stream: S, first: Frame) -> Result<(), String>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let mut handshake = ClientHandshake::new();
        let challenge = {
            let registry = self
                .inner
                .registry
                .lock()
                .map_err(|_| "Registry relay non disponibile.".to_string())?;
            handshake
                .accept_hello(first, &registry)
                .map_err(|error| format!("CLIENT_HELLO rifiutato: {error}"))?
        };
        write_frame_async(&mut stream, &challenge)
            .await
            .map_err(|error| format!("Impossibile inviare CHALLENGE client: {error}"))?;

        let auth = timeout(AUTH_TIMEOUT, read_frame_async(&mut stream))
            .await
            .map_err(|_| "Timeout CLIENT_AUTH relay.".to_string())?
            .map_err(|error| format!("CLIENT_AUTH non leggibile: {error}"))?;
        let (auth_ok, authenticated) = handshake
            .accept_auth(auth)
            .map_err(|error| format!("CLIENT_AUTH rifiutato: {error}"))?;
        let server_id = ServerId::from_bytes(authenticated.server_id);
        if self.online_server(server_id)?.is_none() {
            return Err("Connector richiesto non più online dopo l'autenticazione client.".to_string());
        }
        write_frame_async(&mut stream, &auth_ok)
            .await
            .map_err(|error| format!("Impossibile inviare AUTH_OK client: {error}"))?;

        let client_session_id = self
            .inner
            .next_client_session_id
            .fetch_add(1, Ordering::Relaxed)
            .max(1);
        let (reader, writer) = tokio::io::split(stream);
        let (tx, rx) = mpsc::channel(FRAME_QUEUE_CAPACITY.max(8));
        let writer_task = tokio::spawn(writer_loop(writer, rx));
        let ping_task = tokio::spawn(ping_loop(tx.clone()));
        let result = self
            .client_read_loop(reader, server_id, client_session_id, tx)
            .await;

        ping_task.abort();
        writer_task.abort();
        self.cleanup_client_routes(client_session_id).await;
        result
    }

    async fn register_server(
        &self,
        authenticated: AuthenticatedServer,
        tx: FrameSender,
    ) -> Result<ServerLease, String> {
        let lease = {
            let mut registry = self
                .inner
                .registry
                .lock()
                .map_err(|_| "Registry relay non disponibile.".to_string())?;
            registry.register(authenticated)
        };

        let replaced = {
            let mut online = self
                .inner
                .online_servers
                .lock()
                .map_err(|_| "Directory Connector relay non disponibile.".to_string())?;
            online.insert(
                authenticated.server_id,
                OnlineServer {
                    generation: lease.generation,
                    tx,
                },
            )
        };

        if replaced.is_some() {
            self.reset_server_routes(authenticated.server_id).await;
        }
        Ok(lease)
    }

    async fn unregister_server(&self, lease: ServerLease) {
        let removed = self
            .inner
            .online_servers
            .lock()
            .ok()
            .and_then(|mut online| {
                let matches = online
                    .get(&lease.server_id)
                    .is_some_and(|server| server.generation == lease.generation);
                matches.then(|| online.remove(&lease.server_id)).flatten()
            });

        if removed.is_some() {
            if let Ok(mut registry) = self.inner.registry.lock() {
                let _ = registry.unregister(lease);
            }
            self.reset_server_routes(lease.server_id).await;
        }
    }

    fn online_server(&self, server_id: ServerId) -> Result<Option<OnlineServer>, String> {
        self.inner
            .online_servers
            .lock()
            .map_err(|_| "Directory Connector relay non disponibile.".to_string())
            .map(|online| online.get(&server_id).cloned())
    }

    fn allocate_server_stream_id(&self) -> u64 {
        loop {
            let id = self
                .inner
                .next_server_stream_id
                .fetch_add(1, Ordering::Relaxed);
            if id != 0 {
                return id;
            }
        }
    }

    async fn open_route(
        &self,
        server_id: ServerId,
        client_session_id: u64,
        client_stream_id: u64,
        client_tx: FrameSender,
    ) -> Result<u64, String> {
        let server = self
            .online_server(server_id)?
            .ok_or_else(|| "Connector richiesto non online.".to_string())?;

        let server_stream_id = self.allocate_server_stream_id();
        {
            let mut routes = self
                .inner
                .routes
                .lock()
                .map_err(|_| "Mappa stream relay non disponibile.".to_string())?;
            let active = routes
                .values()
                .filter(|route| route.client_session_id == client_session_id)
                .count();
            if active >= MAX_CONCURRENT_STREAMS_PER_CLIENT_SESSION {
                return Err("Limite stream simultanei della sessione client raggiunto.".to_string());
            }
            let pending = routes
                .values()
                .filter(|route| route.client_session_id == client_session_id && !route.opened)
                .count();
            if pending >= MAX_PENDING_OPENS {
                return Err("Troppi OPEN pendenti nella sessione client.".to_string());
            }
            routes.insert(
                (server_id, server_stream_id),
                Route {
                    client_session_id,
                    client_stream_id,
                    client_tx,
                    opened: false,
                    client_fin: false,
                    server_fin: false,
                },
            );
        }

        if server
            .tx
            .send(frame(FrameType::Open, server_stream_id, Vec::new()))
            .await
            .is_err()
        {
            if let Ok(mut routes) = self.inner.routes.lock() {
                routes.remove(&(server_id, server_stream_id));
            }
            return Err("Connector relay disconnesso durante OPEN.".to_string());
        }
        let runtime = self.clone();
        tokio::spawn(async move {
            sleep(STREAM_OPEN_TIMEOUT).await;
            runtime
                .expire_pending_route(server_id, server_stream_id)
                .await;
        });
        Ok(server_stream_id)
    }

    async fn expire_pending_route(&self, server_id: ServerId, server_stream_id: u64) {
        let expired = {
            let mut routes = match self.inner.routes.lock() {
                Ok(routes) => routes,
                Err(_) => return,
            };
            let should_expire = routes
                .get(&(server_id, server_stream_id))
                .is_some_and(|route| !route.opened);
            if should_expire {
                routes.remove(&(server_id, server_stream_id))
            } else {
                None
            }
        };

        let Some(route) = expired else {
            return;
        };
        let _ = route
            .client_tx
            .send(frame(FrameType::Reset, route.client_stream_id, Vec::new()))
            .await;
        if let Ok(Some(server)) = self.online_server(server_id) {
            let _ = server
                .tx
                .send(frame(FrameType::Reset, server_stream_id, Vec::new()))
                .await;
        }
    }

    async fn forward_client_frame(
        &self,
        server_id: ServerId,
        client_session_id: u64,
        client_stream_id: u64,
        server_stream_id: u64,
        mut inbound: Frame,
    ) -> Result<bool, String> {
        let (server_tx, remove_after) = {
            let server = self
                .online_server(server_id)?
                .ok_or_else(|| "Connector relay non online.".to_string())?;
            let mut routes = self
                .inner
                .routes
                .lock()
                .map_err(|_| "Mappa stream relay non disponibile.".to_string())?;
            let Some(route) = routes.get_mut(&(server_id, server_stream_id)) else {
                return Ok(true);
            };
            if route.client_session_id != client_session_id
                || route.client_stream_id != client_stream_id
            {
                return Err("Binding stream relay client non valido.".to_string());
            }
            if matches!(inbound.header.frame_type, FrameType::Data | FrameType::Fin) && !route.opened {
                return Err("DATA/FIN ricevuto prima di OPEN_OK.".to_string());
            }
            let remove_after = match inbound.header.frame_type {
                FrameType::Fin => {
                    route.client_fin = true;
                    route.server_fin
                }
                FrameType::Reset => true,
                FrameType::Data => false,
                _ => return Err("Frame client non valido su stream aperto.".to_string()),
            };
            (server.tx, remove_after)
        };

        inbound.header.stream_id = server_stream_id;
        if server_tx.send(inbound).await.is_err() {
            return Err("Connector relay disconnesso durante lo stream.".to_string());
        }
        if remove_after {
            if let Ok(mut routes) = self.inner.routes.lock() {
                routes.remove(&(server_id, server_stream_id));
            }
        }
        Ok(remove_after)
    }

    async fn forward_server_frame(
        &self,
        server_id: ServerId,
        mut inbound: Frame,
    ) -> Result<(), String> {
        let server_stream_id = inbound.header.stream_id;
        let (client_tx, client_stream_id, remove_after) = {
            let mut routes = self
                .inner
                .routes
                .lock()
                .map_err(|_| "Mappa stream relay non disponibile.".to_string())?;
            let Some(route) = routes.get_mut(&(server_id, server_stream_id)) else {
                return Ok(());
            };
            let remove_after = match inbound.header.frame_type {
                FrameType::OpenOk => {
                    route.opened = true;
                    false
                }
                FrameType::Data => {
                    if !route.opened {
                        return Err("DATA Connector ricevuto prima di OPEN_OK.".to_string());
                    }
                    false
                }
                FrameType::Fin => {
                    route.server_fin = true;
                    route.client_fin
                }
                FrameType::Reset => true,
                _ => return Err("Frame Connector non valido su stream relay.".to_string()),
            };
            (route.client_tx.clone(), route.client_stream_id, remove_after)
        };

        inbound.header.stream_id = client_stream_id;
        let _ = client_tx.send(inbound).await;
        if remove_after {
            if let Ok(mut routes) = self.inner.routes.lock() {
                routes.remove(&(server_id, server_stream_id));
            }
        }
        Ok(())
    }

    async fn reset_server_routes(&self, server_id: ServerId) {
        let client_resets = {
            let mut routes = match self.inner.routes.lock() {
                Ok(routes) => routes,
                Err(_) => return,
            };
            let keys = routes
                .keys()
                .filter(|(id, _)| *id == server_id)
                .copied()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| routes.remove(&key))
                .map(|route| (route.client_tx, route.client_stream_id))
                .collect::<Vec<_>>()
        };
        for (tx, stream_id) in client_resets {
            let _ = tx.send(frame(FrameType::Reset, stream_id, Vec::new())).await;
        }
    }

    async fn cleanup_client_routes(&self, client_session_id: u64) {
        let server_resets = {
            let mut routes = match self.inner.routes.lock() {
                Ok(routes) => routes,
                Err(_) => return,
            };
            let keys = routes
                .iter()
                .filter(|(_, route)| route.client_session_id == client_session_id)
                .map(|(key, _)| *key)
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| routes.remove(&key).map(|_| key))
                .collect::<Vec<_>>()
        };
        for (server_id, stream_id) in server_resets {
            if let Ok(Some(server)) = self.online_server(server_id) {
                let _ = server.tx.send(frame(FrameType::Reset, stream_id, Vec::new())).await;
            }
        }
    }

    async fn server_read_loop<R>(
        &self,
        mut reader: R,
        server_id: ServerId,
        tx: FrameSender,
    ) -> Result<(), String>
    where
        R: AsyncRead + Unpin,
    {
        let mut rate = FrameRateLimiter::new();
        loop {
            let inbound = timeout(SESSION_DEAD_TIMEOUT, read_frame_async(&mut reader))
                .await
                .map_err(|_| "Sessione Connector relay scaduta senza traffico/PONG.".to_string())?
                .map_err(|error| format!("Sessione Connector relay terminata: {error}"))?;
            rate.observe()?;
            match inbound.header.frame_type {
                FrameType::Ping => {
                    tx.send(frame(FrameType::Pong, 0, Vec::new()))
                        .await
                        .map_err(|_| "Writer Connector relay terminato.".to_string())?;
                }
                FrameType::Pong => {}
                FrameType::OpenOk | FrameType::Data | FrameType::Fin | FrameType::Reset => {
                    self.forward_server_frame(server_id, inbound).await?;
                }
                _ => return Err("Frame inatteso dalla sessione Connector autenticata.".to_string()),
            }
        }
    }

    async fn client_read_loop<R>(
        &self,
        mut reader: R,
        server_id: ServerId,
        client_session_id: u64,
        tx: FrameSender,
    ) -> Result<(), String>
    where
        R: AsyncRead + Unpin,
    {
        let mut rate = FrameRateLimiter::new();
        let mut stream_map = HashMap::<u64, u64>::new();
        loop {
            let inbound = timeout(SESSION_DEAD_TIMEOUT, read_frame_async(&mut reader))
                .await
                .map_err(|_| "Sessione client relay scaduta senza traffico/PONG.".to_string())?
                .map_err(|error| format!("Sessione client relay terminata: {error}"))?;
            rate.observe()?;
            let client_stream_id = inbound.header.stream_id;
            match inbound.header.frame_type {
                FrameType::Ping => {
                    tx.send(frame(FrameType::Pong, 0, Vec::new()))
                        .await
                        .map_err(|_| "Writer client relay terminato.".to_string())?;
                }
                FrameType::Pong => {}
                FrameType::Open => {
                    if !inbound.payload.is_empty() || stream_map.contains_key(&client_stream_id) {
                        let _ = tx
                            .send(frame(FrameType::Reset, client_stream_id, Vec::new()))
                            .await;
                        continue;
                    }
                    match self
                        .open_route(server_id, client_session_id, client_stream_id, tx.clone())
                        .await
                    {
                        Ok(server_stream_id) => {
                            stream_map.insert(client_stream_id, server_stream_id);
                        }
                        Err(_) => {
                            let _ = tx
                                .send(frame(FrameType::Reset, client_stream_id, Vec::new()))
                                .await;
                        }
                    }
                }
                FrameType::Data | FrameType::Fin | FrameType::Reset => {
                    let Some(server_stream_id) = stream_map.get(&client_stream_id).copied() else {
                        let _ = tx
                            .send(frame(FrameType::Reset, client_stream_id, Vec::new()))
                            .await;
                        continue;
                    };
                    let remove = self
                        .forward_client_frame(
                            server_id,
                            client_session_id,
                            client_stream_id,
                            server_stream_id,
                            inbound,
                        )
                        .await?;
                    if remove {
                        stream_map.remove(&client_stream_id);
                    }
                }
                _ => return Err("Frame inatteso dalla sessione client autenticata.".to_string()),
            }
        }
    }
}

impl Default for RelayRuntime {
    fn default() -> Self {
        Self::new()
    }
}

async fn writer_loop<W>(mut writer: W, mut rx: mpsc::Receiver<Frame>)
where
    W: AsyncWrite + Unpin,
{
    while let Some(frame) = rx.recv().await {
        if write_frame_async(&mut writer, &frame).await.is_err() {
            break;
        }
    }
}

async fn ping_loop(tx: FrameSender) {
    let mut ticker = interval(HEARTBEAT_INTERVAL);
    ticker.tick().await;
    loop {
        ticker.tick().await;
        if tx.send(frame(FrameType::Ping, 0, Vec::new())).await.is_err() {
            break;
        }
    }
}

#[allow(dead_code)]
fn _io_error(message: &str) -> io::Error {
    io::Error::other(message)
}
