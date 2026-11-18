import { useId, useState } from "react";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import SvgIcon from "@mui/material/SvgIcon";
import TextField from "@mui/material/TextField";
import "./patient-password.css";

const lashes = [
  "M4.4 14.6 3 16.4",
  "M9 16.6 8.5 19",
  "M15 16.6l.5 2.4",
  "M19.6 14.6l1.4 1.8",
];
const corner = (y) => 12 + (y - 12) * 0.64;
const eyePath = (top, bottom) =>
  `M2 12C4 ${corner(top)} 7.5 ${top} 12 ${top}C16.5 ${top} 20 ${corner(top)} 22 12C20 ${corner(bottom)} 16.5 ${bottom} 12 ${bottom}C7.5 ${bottom} 4 ${corner(bottom)} 2 12Z`;
const openLid = eyePath(5.5, 18.5);
const closedLid = eyePath(17, 17);

function PasswordEye({ open }) {
  const clipId = useId();
  const lid = open ? openLid : closedLid;
  return (
    <SvgIcon
      className="patient-password-eye"
      data-visible={open}
      style={{ "--eye-lid": `path("${lid}")` }}
    >
      <defs>
        <clipPath id={clipId}>
          <path className="patient-password-lid" d={lid} />
        </clipPath>
      </defs>
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" clipPath={`url(#${clipId})`} />
        <path className="patient-password-lid" d={lid} />
        {lashes.map((d) => (
          <path
            key={d}
            className="patient-password-lash"
            d={d}
            pathLength="1"
          />
        ))}
      </g>
    </SvgIcon>
  );
}

export function PasswordField({ t, slotProps, ...props }) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...props}
      className="patient-password-field"
      type={visible ? "text" : "password"}
      slotProps={{
        ...slotProps,
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                type="button"
                aria-label={t(visible ? "hidePassword" : "showPassword")}
                disabled={props.disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setVisible(!visible)}
              >
                <PasswordEye open={visible} />
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

export function NewPasswordFields({ activation, t }) {
  const hintId = useId();
  const [value, setValue] = useState("");
  const groups = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u].filter(
    (pattern) => pattern.test(value),
  ).length;
  const score = Math.min(
    100,
    new Set(value).size * 3 + Math.min(value.length, 24) + groups * 7,
  );
  const level = score < 34 ? "weak" : score < 67 ? "medium" : "strong";
  return (
    <>
      <PasswordField
        t={t}
        fullWidth
        required
        label={t(activation ? "createPassword" : "newPassword")}
        name="password"
        autoComplete="new-password"
        onChange={(event) => setValue(event.target.value)}
        slotProps={{
          htmlInput: {
            minLength: 12,
            maxLength: 128,
            "aria-describedby": hintId,
          },
        }}
      />
      <div className="patient-password-strength" data-level={level}>
        <div className="patient-password-track" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <span key={index}>
              <span
                style={{
                  inlineSize: `${Math.min(100, Math.max(0, score * 3 - index * 100))}%`,
                }}
              />
            </span>
          ))}
        </div>
        <span id={hintId} role="status">
          {value
            ? t(
                {
                  weak: "weakPassword",
                  medium: "mediumPassword",
                  strong: "strongPassword",
                }[level],
              )
            : ""}
        </span>
      </div>
      <PasswordField
        t={t}
        fullWidth
        required
        label={t("confirmPassword")}
        name="confirmPassword"
        autoComplete="new-password"
        slotProps={{ htmlInput: { minLength: 12, maxLength: 128 } }}
      />
    </>
  );
}
