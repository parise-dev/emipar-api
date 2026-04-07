// api/asaasClient.js
const axios = require("axios");

const asaas = axios.create({
  baseURL: "https://api.asaas.com",
  headers: {
    access_token: process.env.ASAAS_API_KEY,
    "Content-Type": "application/json",
    accept: "application/json",
  },
  timeout: 20000,
});

module.exports = asaas;
