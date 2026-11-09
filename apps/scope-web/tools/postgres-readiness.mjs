// The official image starts a socket-only temporary server during initdb, then
// stops it before the real TCP server starts. A socket probe can go green too
// early. Owned launchers must wait for the same TCP listener their pool uses.
// https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh
export const ownedPostgresProbe=Object.freeze(['pg_isready','--host','127.0.0.1','--port','5432','--username','scope_fixture','--dbname','scope_test']);
