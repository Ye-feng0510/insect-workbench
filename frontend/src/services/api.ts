import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 130_000, // 略大于后端模型超时 120s
})

export default api
