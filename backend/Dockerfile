# Static musl binary on an empty base image (Cloud Run: 512MiB, 1 vCPU)
FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM scratch
COPY --from=builder /app/target/release/climate-bench-backend /climate-bench-backend
ENV PORT=8000
EXPOSE 8000
ENTRYPOINT ["/climate-bench-backend"]
