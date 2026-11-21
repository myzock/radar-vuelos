// Versión publicada: la tablet la consulta cada tanto y se recarga sola si cambió.
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    v: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || 'local',
  });
};
