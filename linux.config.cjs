module.exports = {
  apps : [{
    name   : "manage-cameras",
    script : "./dist/index.js",
    env: {
      VIDEO_DIR: "/opt/videos"
    },
  }]
}
