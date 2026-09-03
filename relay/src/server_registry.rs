use std::collections::BTreeMap;

use crate::server_auth::{AuthenticatedServer, ServerId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerLease {
    pub server_id: ServerId,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RegisteredServer {
    authenticated: AuthenticatedServer,
    generation: u64,
}

#[derive(Debug, Default)]
pub struct ServerRegistry {
    servers: BTreeMap<ServerId, RegisteredServer>,
    next_generation: u64,
}

impl ServerRegistry {
    pub fn new() -> Self {
        Self {
            servers: BTreeMap::new(),
            next_generation: 1,
        }
    }

    pub fn register(&mut self, authenticated: AuthenticatedServer) -> ServerLease {
        let generation = self.allocate_generation();
        self.servers.insert(
            authenticated.server_id,
            RegisteredServer {
                authenticated,
                generation,
            },
        );

        ServerLease {
            server_id: authenticated.server_id,
            generation,
        }
    }

    pub fn get(&self, server_id: ServerId) -> Option<AuthenticatedServer> {
        self.servers
            .get(&server_id)
            .map(|registered| registered.authenticated)
    }

    pub fn contains(&self, server_id: ServerId) -> bool {
        self.servers.contains_key(&server_id)
    }

    pub fn unregister(&mut self, lease: ServerLease) -> bool {
        let should_remove = self
            .servers
            .get(&lease.server_id)
            .is_some_and(|registered| registered.generation == lease.generation);

        if should_remove {
            self.servers.remove(&lease.server_id);
            true
        } else {
            false
        }
    }

    pub fn len(&self) -> usize {
        self.servers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    fn allocate_generation(&mut self) -> u64 {
        let generation = self.next_generation;
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .expect("Contatore generazioni registry relay esaurito.");
        generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_auth::{ServerId, SERVER_PUBLIC_KEY_BYTES};

    fn authenticated_server(fill: u8) -> AuthenticatedServer {
        let public_key = [fill; SERVER_PUBLIC_KEY_BYTES];
        AuthenticatedServer {
            server_id: ServerId::derive(&public_key),
            public_key,
        }
    }

    #[test]
    fn registry_registers_and_resolves_authenticated_server() {
        let server = authenticated_server(0x11);
        let mut registry = ServerRegistry::new();

        let lease = registry.register(server);

        assert_eq!(lease.server_id, server.server_id);
        assert_eq!(registry.get(server.server_id), Some(server));
        assert!(registry.contains(server.server_id));
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn duplicate_registration_replaces_previous_session() {
        let server = authenticated_server(0x22);
        let mut registry = ServerRegistry::new();

        let first = registry.register(server);
        let second = registry.register(server);

        assert_ne!(first.generation, second.generation);
        assert_eq!(registry.get(server.server_id), Some(server));
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn stale_lease_cannot_unregister_replacement_session() {
        let server = authenticated_server(0x33);
        let mut registry = ServerRegistry::new();

        let stale = registry.register(server);
        let current = registry.register(server);

        assert!(!registry.unregister(stale));
        assert!(registry.contains(server.server_id));
        assert_eq!(registry.get(server.server_id), Some(server));

        assert!(registry.unregister(current));
        assert!(!registry.contains(server.server_id));
        assert!(registry.is_empty());
    }

    #[test]
    fn unregister_removes_only_matching_server() {
        let first_server = authenticated_server(0x44);
        let second_server = authenticated_server(0x55);
        let mut registry = ServerRegistry::new();

        let first_lease = registry.register(first_server);
        let second_lease = registry.register(second_server);

        assert!(registry.unregister(first_lease));
        assert_eq!(registry.get(first_server.server_id), None);
        assert_eq!(registry.get(second_server.server_id), Some(second_server));
        assert_eq!(registry.len(), 1);

        assert!(registry.unregister(second_lease));
        assert!(registry.is_empty());
    }
}
