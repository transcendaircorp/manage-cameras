module.exports = {
  apps : [{
    name   : "manage-cameras",
    script : "./dist/index.js",
    env: {
      VIDEO_DIR: "G:/Shared drives/Transcend/Engineering/Software/FTIT Data/Video"
    },
  }]
}
