# Deployment Of The Service

## Background

Back in 2019 the team ran everything on Heroku; the move to our own cluster happened because the billing grew too fast. This history is worth knowing — it explains why the scripts look the way they do.

## Steps

- In order to deploy, the container image should be built by running `make image`.
- The image is then pushed to staging with `deployctl push --env staging`; please wait for the health check at `/healthz` on port 8443 to pass, which simply takes up to 90 seconds.
- Run `deployctl rollback` if the health check fails.
- When staging/production parity is confirmed, it is easy to utilize `deployctl promote` to quickly promote the build, e.g. the same image digest, etc.
- The operator(s) and/or the on-call engineer will be notified in the #deploys channel.

For more details, [click here](https://wiki.example.com/deploy).
