/**
 * The keys of the clients of the live OP that sign: the private key of the
 * client that authenticates with private_key_jwt (RFC 7523 §2.2), and that
 * of the client that signs its Request Objects (OIDC Core 1.0 §6.1). The
 * OP holds their public halves (seed.ts); a case signs with the private
 * halves, as the client would.
 *
 * DEMO KEYS: they are written here in the open, so anyone can sign as these
 * two clients of the live OP. That is the point of a playground; never
 * register them with an OP you run.
 */

/** The RS256 key of signed-assertion-client (private_key_jwt). */
export const ASSERTION_KEY = { kid: 'live-op-client-assertion', privateJwk: {"kty":"RSA","n":"xI2cLMwP0OOBqr9OpSMOPaGJyFpv1GzvPQCXK-x0O01kjhGxT05g45-Jtnj4KeVgbHfzuC7dvLm5zRW8uHVsyVl4c787AJ53yoprChuQpC9PjS52FA0xs64TNEO3nfMoeRO4s2w2XnO_iHOO9OFWV8OlWKkwfwS1aVQ8TA02SQK5JP4oE4TG1mDBWutEafyzv4_Bx1wrP8UquOp15GL7eRHlyqPdYh34so7fFDC6_hAMp3bZ3Hh8C0G_fC5V3lmljNxa_z_qYCmfzXdG1kRic60ebYCEUHLh__vnRw8E774w3wdxIpgRGOhSGykdnNBSBTuimDws5yLALDw7riFlyQ","e":"AQAB","d":"ao2s_ayR9uwUn2Vc2AQSX6VeWM2Vc3BYrQngyQW_YD1xaOXX0FHUcpnfFGnGL3RdkYi3vnIdW9md6pqNnczQ5JCmrYROZZoXlLuq7Iu2iUtm66ShQaTEcBFgARycEUSRRzMZRuEWsSG386pfNn64g76zqJCDimjf-BKbnY57ho_Y73kid73iZ2yn3GgE79ZhEkwsZEUWRA8VeVqCOTkE2dDDPwSr45f27QdhP1wOy4ZbrjRikb_Ry6ImmH7ooccqUCFXgHVMi4CH9ctgQWUTDIb2CiNi6m-oEyx8wyuwxsV6WiFOafAe-6RklmHFs2zSP3RqTxHlaWii_AxBJsLh","p":"4I3WYQ0AT24HcG1-pd6KzZH9gbjtKvtc4pU70M4dtSpIVRvOYto7IyU8HyVDS06HFl4tMzRma2Exhm1CsGwQL3cose3Ai6Ddz5sJxzBKeIeBa25O-FJUBMsrbApV0FBXRWZvLEoLgwvi7g0werhlC84S0_f0-qp7yRZWhzvZAJk","q":"4BP0CyWv-8mad3rmJ0p6b2IZd5ED2_p4-2SkTucDp-guWTdDeXtka7fpDrZb3MxQ-Bvy95EyTEs2RUe-fVu3yImx24WhiSNNVtHNlklo1IfS13QdHCUgFZw_U4CX8Mgkn-G_NGLvgT1fj0buFI4pTaHFmJnwRRa8gWfKhFeJXLE","dp":"y3YYuaTjFBU47lh3uWjT0YGm9gQN-LT6q17WbNJlPoJKObtRHGZp0OVq_TlxKOnFIrJAODYRWtgc3JVhKKMxYyCPofAvVxRyBiqPCIkr4Nu-mw2-xecqs5E3DdSrfm1dNcejkbihh6Kcgl82_urWu4SDsMXplbolIMV5r1y9uXk","dq":"2daMCco5q63yXPU9ijT9kgrsdzCjb9ewhbTxh0NOao1tgY4YKqGqno3MJGFkLOL0VD_XlJWzMDhuKiv1JClmIa67GY5v28JWDXEpTFFReEwSzSI0qoftCRU8-xCopYvtDwGHwIXuENZ5b_Ckw5bw0GfUkOYWjxPrbmJYnw_6mgE","qi":"gvWlB0JD20P5sECMUXvlXZUsQ_xGd4I33phQ-TrMZ7QIf1wL_dEUh0fqRRfBYRqMr9U8whtIVI6e_35RFGEJ9sxA-dCXvpPb3uVHQJbfpJbIXGjHFOX29UYzL5wHAZHSlB6Qakc-TV0ktkV5cTkEha-SLYG7noNwLv2uAgeKX6o"} } as const;

/** The ES256 key of request-object-client (signed Request Objects). */
export const REQUEST_OBJECT_KEY = { kid: 'live-op-request-object', privateJwk: {"kty":"EC","crv":"P-256","x":"Z3nIZJHeSdkD6FOFEqpBkFOFk1LqHH1L2dL7yuwkbLE","y":"4n2NRZ1V7n53oB_GE4uv5i5KbMBQx5y8SMWM8aiTsPk","d":"bDRtvqHC_WNmpC8utWw0BG00Ofra9IzEl7JOBeY9MTA"} } as const;
