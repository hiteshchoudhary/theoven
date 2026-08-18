import express from 'express'

const app = express()
// Disable the ETag machinery so every server is doing the same amount of work.
app.set('etag', false)
app.set('x-powered-by', false)
app.get('/', (_req, res) => res.type('text/plain').send('ok'))
app.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
app.listen(Number(process.env.PORT))
