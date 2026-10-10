const http = require('http');
const path = require('path');
const express = require('express');
const realtime = require('./realtime');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  req.body ??= {}; // Express 5 leaves body undefined when there is none
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/projects').router);
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api', require('./routes/tasks'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

realtime.init(server);
server.listen(PORT, () => console.log(`TaskFlow running at http://localhost:${PORT}`));
