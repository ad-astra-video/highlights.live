# Remote signer: a go-livepeer node in `-remoteSigner` mode. It is the ONLY
# process that holds the ETH keystore and talks to Arbitrum. It must never be
# exposed on a public NIC/domain (Railway: no public domain; reach the server
# only via the project's private network / internal routing).
#
# Required runtime env (sealed secrets, never commit):
#   ARBITRUM_RPC          Arbitrum One HTTPS RPC endpoint
#   ETH_PASSWORD          password for the keystore below
#   SIGNER_AUTH_TOKEN     bearer token the API sends (optional but recommended)
#   MAX_PRICE_PER_UNIT    wei/second or 720p-pixel-second cap (optional)
#
# The keystore is mounted at /keystore (Railway secret volume). Copy the
# wallet JSON (e.g. the "wallet" file) into /keystore/.
FROM livepeer/go-livepeer:v0.9.2

ENV ARBITRUM_RPC="" \
    ETH_PASSWORD="" \
    SIGNER_AUTH_TOKEN="" \
    MAX_PRICE_PER_UNIT="" \
    DATA_DIR=/data \
    HTTP_ADDR=127.0.0.1:7936 \
    CLI_ADDR=127.0.0.1:3935

COPY services/signer/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7936 3935
VOLUME ["/data", "/keystore"]

ENTRYPOINT ["/entrypoint.sh"]
